/**
 * Multi-repo workspace helpers — browser-safe (no Node imports), shared by the
 * dashboard (`@understand-anything/core/workspace`) and `/understand-diff`.
 *
 * A workspace graph namespaces every member id as `<prefix>:<M>/<rest>` and
 * every filePath as `<M>/<path>` (docs/multi-repo-workspace.md). The contract
 * linker adds cross-service links on top: `endpoint` nodes with `routes`
 * edges from the provider file, `calls` edges (crossService, confidence,
 * evidence) from consumer files, `publishes`/`subscribes` edges to shared
 * `concept:<system>/<channel>` nodes and `reads_from`/`writes_to` edges to
 * shared `table:workspace/<schema.table>` nodes.
 */
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./types.js";

type GraphLike = Pick<KnowledgeGraph, "project" | "nodes" | "edges">;

/** Node types that represent one file of a member (the "file count" of a service). */
export const WORKSPACE_FILE_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "file",
  "config",
  "document",
  "service",
  "pipeline",
  "schema",
  "resource",
]);

/** Member names in manifest order; `[]` for a graph that is not a workspace. */
export function getWorkspaceMemberNames(
  graph: Pick<KnowledgeGraph, "project"> | null | undefined,
): string[] {
  const members = graph?.project?.workspace?.members;
  if (!Array.isArray(members)) return [];
  const out: string[] = [];
  for (const m of members) {
    if (m && typeof m.name === "string" && m.name && !out.includes(m.name)) out.push(m.name);
  }
  return out;
}

/**
 * Member that owns a namespaced id (`file:M/a.ts`, `layer:M/x`, `M/legacy`),
 * or null when the namespace segment is not a declared member.
 */
export function memberOfId(
  id: string,
  members: ReadonlySet<string> | readonly string[],
): string | null {
  const colon = id.indexOf(":");
  const rest = colon >= 0 ? id.slice(colon + 1) : id;
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const candidate = rest.slice(0, slash);
  const has = members instanceof Set ? members.has(candidate) : (members as readonly string[]).includes(candidate);
  return has ? candidate : null;
}

/**
 * Linker-generated shared nodes (message channels, shared tables) belong to no
 * member, even when their namespace segment happens to equal a member name.
 */
export function isSharedContractNode(node: Pick<GraphNode, "type" | "tags">): boolean {
  return (
    (node.type === "concept" || node.type === "table") &&
    Array.isArray(node.tags) &&
    node.tags.includes("contract")
  );
}

export function memberOfNode(
  node: Pick<GraphNode, "id" | "type" | "tags">,
  members: ReadonlySet<string> | readonly string[],
): string | null {
  if (isSharedContractNode(node)) return null;
  return memberOfId(node.id, members);
}

/** `src/a.ts` of member `M` → `M/src/a.ts` (the workspace filePath form). */
export function namespaceChangedFiles(member: string, files: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of files) {
    const rel = raw.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (!rel) continue;
    out.push(`${member}/${rel}`);
  }
  return out;
}

// ── Service-level view ─────────────────────────────────────────────────────

export interface ServiceSummary {
  name: string;
  /** File-level nodes of the member (see WORKSPACE_FILE_LEVEL_TYPES). */
  fileCount: number;
  nodeCount: number;
}

export interface ServiceLink {
  source: string;
  target: string;
  /** Cross-service `calls` edges from `source` files to `target` endpoints. */
  calls: number;
  /** Channels `source` publishes to that `target` subscribes to. */
  messages: number;
  /** Shared tables (writer → reader when one side only reads, else manifest order). */
  tables: number;
}

export interface ServiceGraph {
  services: ServiceSummary[];
  links: ServiceLink[];
}

interface Indexes {
  members: string[];
  memberSet: Set<string>;
  nodesById: Map<string, GraphNode>;
  memberOf: (id: string) => string | null;
}

function indexes(graph: GraphLike): Indexes {
  const members = getWorkspaceMemberNames(graph);
  const memberSet = new Set(members);
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodesById.set(n.id, n);
  const memberOf = (id: string): string | null => {
    const n = nodesById.get(id);
    return n ? memberOfNode(n, memberSet) : memberOfId(id, memberSet);
  };
  return { members, memberSet, nodesById, memberOf };
}

/** One service per member plus links aggregated from cross-service edges. */
export function buildServiceGraph(graph: GraphLike): ServiceGraph {
  const { members, memberSet, memberOf } = indexes(graph);
  if (members.length === 0) return { services: [], links: [] };

  const fileCount = new Map<string, number>();
  const nodeCount = new Map<string, number>();
  for (const n of graph.nodes) {
    const m = memberOfNode(n, memberSet);
    if (!m) continue;
    nodeCount.set(m, (nodeCount.get(m) ?? 0) + 1);
    if (WORKSPACE_FILE_LEVEL_TYPES.has(n.type)) fileCount.set(m, (fileCount.get(m) ?? 0) + 1);
  }
  const services = members.map((name) => ({
    name,
    fileCount: fileCount.get(name) ?? 0,
    nodeCount: nodeCount.get(name) ?? 0,
  }));

  const links = new Map<string, ServiceLink>();
  const link = (source: string, target: string): ServiceLink => {
    const key = `${source}\u0000${target}`;
    let l = links.get(key);
    if (!l) {
      l = { source, target, calls: 0, messages: 0, tables: 0 };
      links.set(key, l);
    }
    return l;
  };

  // Shared hubs: channel → publishers/subscribers, table → writers/readers.
  const publishers = new Map<string, Set<string>>();
  const subscribers = new Map<string, Set<string>>();
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, m: string) => {
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(m);
  };

  for (const e of graph.edges) {
    const sm = memberOf(e.source);
    if (!sm) continue;
    switch (e.type) {
      case "calls": {
        const tm = memberOf(e.target);
        if (tm && tm !== sm) link(sm, tm).calls++;
        break;
      }
      case "publishes":
        add(publishers, e.target, sm);
        break;
      case "subscribes":
        add(subscribers, e.target, sm);
        break;
      case "writes_to":
        add(writers, e.target, sm);
        break;
      case "reads_from":
        add(readers, e.target, sm);
        break;
      default:
        break;
    }
  }

  for (const [channel, pubs] of publishers) {
    const subs = subscribers.get(channel);
    if (!subs) continue;
    for (const p of pubs) for (const s of subs) if (p !== s) link(p, s).messages++;
  }

  const order = new Map(members.map((m, i) => [m, i]));
  const tableIds = new Set([...writers.keys(), ...readers.keys()]);
  for (const table of tableIds) {
    const w = writers.get(table) ?? new Set<string>();
    const r = readers.get(table) ?? new Set<string>();
    const touching = [...new Set([...w, ...r])].sort((a, b) => (order.get(a)! - order.get(b)!));
    for (let i = 0; i < touching.length; i++) {
      for (let j = i + 1; j < touching.length; j++) {
        let [a, b] = [touching[i], touching[j]];
        // Point writer → reader when exactly one side writes.
        if (!w.has(a) && w.has(b)) [a, b] = [b, a];
        link(a, b).tables++;
      }
    }
  }

  const sorted = [...links.values()].sort(
    (x, y) =>
      order.get(x.source)! - order.get(y.source)! || order.get(x.target)! - order.get(y.target)!,
  );
  return { services, links: sorted };
}

// ── Endpoint consumers ─────────────────────────────────────────────────────

export interface CrossServiceConsumer {
  endpointId: string;
  nodeId: string;
  member: string;
  filePath?: string;
  /** `M/file:line` of the call site, when the linker recorded it. */
  evidence?: string;
  confidence?: number;
  via?: string;
}

function consumerFromEdge(
  e: GraphEdge,
  member: string,
  nodesById: Map<string, GraphNode>,
): CrossServiceConsumer {
  const n = nodesById.get(e.source);
  const c: CrossServiceConsumer = { endpointId: e.target, nodeId: e.source, member };
  if (n?.filePath) c.filePath = n.filePath;
  if (typeof e.evidence?.consumer === "string") c.evidence = e.evidence.consumer;
  if (typeof e.confidence === "number") c.confidence = e.confidence;
  if (typeof e.evidence?.via === "string") c.via = e.evidence.via;
  return c;
}

function byConsumer(a: CrossServiceConsumer, b: CrossServiceConsumer): number {
  return (
    a.member.localeCompare(b.member) ||
    (a.evidence ?? a.nodeId).localeCompare(b.evidence ?? b.nodeId) ||
    a.endpointId.localeCompare(b.endpointId)
  );
}

/** Files of OTHER members that call `endpointId` (cross-service `calls` edges). */
export function getEndpointConsumers(graph: GraphLike, endpointId: string): CrossServiceConsumer[] {
  const { members, nodesById, memberOf } = indexes(graph);
  if (members.length === 0) return [];
  const provider = memberOf(endpointId);
  const out: CrossServiceConsumer[] = [];
  for (const e of graph.edges) {
    if (e.type !== "calls" || e.target !== endpointId) continue;
    const m = memberOf(e.source);
    if (!m || m === provider) continue;
    out.push(consumerFromEdge(e, m, nodesById));
  }
  return out.sort(byConsumer);
}

// ── Cross-service diff impact ──────────────────────────────────────────────

export interface AffectedEndpoint {
  id: string;
  name: string;
  member: string;
  providerFile?: string;
  consumers: CrossServiceConsumer[];
}

export interface ContractTouch {
  nodeId: string;
  member: string;
  role: "publishes" | "subscribes" | "reads_from" | "writes_to";
  filePath?: string;
}

export interface TouchedContract {
  id: string;
  name: string;
  /** Changed nodes touching the channel / table. */
  touchedBy: ContractTouch[];
  /** Nodes of other members on the same channel / table. */
  counterparts: ContractTouch[];
}

export interface OutboundCall {
  nodeId: string;
  member: string;
  endpointId: string;
  endpointName: string;
  endpointMember: string;
  evidence?: string;
}

export interface CrossServiceImpact {
  /** Namespaced changed paths (`M/path`). */
  changedFiles: string[];
  /** Endpoints whose provider file changed, with consumers in other members. */
  endpoints: AffectedEndpoint[];
  /** Calls from changed files to endpoints of other members. */
  outbound: OutboundCall[];
  channels: TouchedContract[];
  tables: TouchedContract[];
  /** Nodes in other members impacted through a contract (sorted, unique). */
  consumerNodeIds: string[];
  /** Members (other than the changed node's own) reached by the impact. */
  affectedMembers: string[];
}

function changedNodeIdsFor(graph: GraphLike, changedFiles: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.filePath && changedFiles.has(n.filePath)) ids.add(n.id);
  }
  for (const e of graph.edges) {
    if (e.type === "contains" && ids.has(e.source)) ids.add(e.target);
  }
  return ids;
}

function endpointProviderFile(id: string, changedFiles: ReadonlySet<string>): string | undefined {
  if (!id.startsWith("endpoint:")) return undefined;
  const rest = id.slice("endpoint:".length);
  for (const f of changedFiles) {
    if (rest.startsWith(`${f}:`)) return f;
  }
  return undefined;
}

/**
 * Cross-service impact of a set of changed files (namespaced `M/path`, see
 * `namespaceChangedFiles`). Returns null when the graph is not a workspace.
 *
 * An endpoint is affected when its provider file changed: the endpoint node's
 * filePath, the source of its `routes` edge, or the file encoded in its id
 * (`endpoint:M/file:METHOD route` — this also covers a deleted or renamed
 * provider when the old path is passed in, i.e. a route that moved away).
 */
export function buildCrossServiceImpact(
  graph: GraphLike,
  changedFiles: readonly string[],
): CrossServiceImpact | null {
  const { members, nodesById, memberOf } = indexes(graph);
  if (members.length === 0) return null;

  const files = new Set(changedFiles);
  const changed = changedNodeIdsFor(graph, files);

  // Endpoints whose provider changed.
  const endpointIds = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== "endpoint") continue;
    if ((n.filePath && files.has(n.filePath)) || endpointProviderFile(n.id, files)) endpointIds.add(n.id);
  }
  for (const e of graph.edges) {
    if (e.type === "routes" && changed.has(e.source) && nodesById.get(e.target)?.type === "endpoint") {
      endpointIds.add(e.target);
    }
  }

  const consumersByEndpoint = new Map<string, CrossServiceConsumer[]>();
  const outbound: OutboundCall[] = [];
  const channelTouches = new Map<string, { touchedBy: ContractTouch[]; all: ContractTouch[] }>();
  const tableTouches = new Map<string, { touchedBy: ContractTouch[]; all: ContractTouch[] }>();

  for (const e of graph.edges) {
    if (e.type === "calls") {
      const sm = memberOf(e.source);
      const tm = memberOf(e.target);
      if (!sm || !tm || sm === tm) continue;
      if (endpointIds.has(e.target)) {
        const list = consumersByEndpoint.get(e.target) ?? [];
        list.push(consumerFromEdge(e, sm, nodesById));
        consumersByEndpoint.set(e.target, list);
      }
      if (changed.has(e.source)) {
        const ep = nodesById.get(e.target);
        const call: OutboundCall = {
          nodeId: e.source,
          member: sm,
          endpointId: e.target,
          endpointName: ep?.name ?? e.target,
          endpointMember: tm,
        };
        if (typeof e.evidence?.consumer === "string") call.evidence = e.evidence.consumer;
        outbound.push(call);
      }
      continue;
    }
    const hub =
      e.type === "publishes" || e.type === "subscribes"
        ? channelTouches
        : e.type === "reads_from" || e.type === "writes_to"
          ? tableTouches
          : null;
    if (!hub) continue;
    const target = nodesById.get(e.target);
    if (!target || !isSharedContractNode(target)) continue;
    const m = memberOf(e.source);
    if (!m) continue;
    const touch: ContractTouch = { nodeId: e.source, member: m, role: e.type as ContractTouch["role"] };
    const fp = nodesById.get(e.source)?.filePath;
    if (fp) touch.filePath = fp;
    const entry = hub.get(e.target) ?? { touchedBy: [], all: [] };
    entry.all.push(touch);
    if (changed.has(e.source)) entry.touchedBy.push(touch);
    hub.set(e.target, entry);
  }

  const byTouch = (a: ContractTouch, b: ContractTouch) =>
    a.member.localeCompare(b.member) || a.nodeId.localeCompare(b.nodeId) || a.role.localeCompare(b.role);

  const contracts = (hub: Map<string, { touchedBy: ContractTouch[]; all: ContractTouch[] }>): TouchedContract[] => {
    const out: TouchedContract[] = [];
    for (const [id, { touchedBy, all }] of hub) {
      if (touchedBy.length === 0) continue;
      const own = new Set(touchedBy.map((t) => t.member));
      const counterparts = all.filter((t) => !own.has(t.member));
      out.push({
        id,
        name: nodesById.get(id)?.name ?? id,
        touchedBy: [...touchedBy].sort(byTouch),
        counterparts: counterparts.sort(byTouch),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };

  const endpoints: AffectedEndpoint[] = [...endpointIds].sort().map((id) => {
    const n = nodesById.get(id);
    const ep: AffectedEndpoint = {
      id,
      name: n?.name ?? id,
      member: memberOf(id) ?? "",
      consumers: (consumersByEndpoint.get(id) ?? []).sort(byConsumer),
    };
    const providerFile = n?.filePath ?? endpointProviderFile(id, files);
    if (providerFile) ep.providerFile = providerFile;
    return ep;
  });

  const channels = contracts(channelTouches);
  const tables = contracts(tableTouches);
  outbound.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.endpointId.localeCompare(b.endpointId));

  const consumerNodeIds = new Set<string>();
  const affectedMembers = new Set<string>();
  for (const ep of endpoints) {
    for (const c of ep.consumers) {
      consumerNodeIds.add(c.nodeId);
      affectedMembers.add(c.member);
    }
  }
  for (const c of [...channels, ...tables]) {
    for (const t of c.counterparts) {
      consumerNodeIds.add(t.nodeId);
      affectedMembers.add(t.member);
    }
  }
  for (const o of outbound) affectedMembers.add(o.endpointMember);

  const order = new Map(members.map((m, i) => [m, i]));
  return {
    changedFiles: [...changedFiles],
    endpoints,
    outbound,
    channels,
    tables,
    consumerNodeIds: [...consumerNodeIds].sort(),
    affectedMembers: [...affectedMembers].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
  };
}

function formatConfidence(c: number | undefined): string | null {
  return typeof c === "number" ? `confidence ${Number(c.toFixed(3))}` : null;
}

function touchLabel(t: ContractTouch): string {
  return `\`${t.filePath ?? t.nodeId}\` (${t.member}, ${t.role.replace("_", " ")})`;
}

/** Markdown section for `/understand-diff` in a workspace. */
export function formatCrossServiceImpact(impact: CrossServiceImpact): string {
  const lines: string[] = ["## Cross-Service Impact", ""];
  const empty =
    impact.endpoints.length === 0 &&
    impact.outbound.length === 0 &&
    impact.channels.length === 0 &&
    impact.tables.length === 0;
  if (empty) {
    lines.push("No cross-service impact detected.", "");
    return lines.join("\n");
  }

  if (impact.endpoints.length > 0) {
    lines.push(`### Endpoints affected (${impact.endpoints.length})`, "");
    for (const ep of impact.endpoints) {
      const provider = ep.providerFile ? ` — provider \`${ep.providerFile}\`` : "";
      lines.push(`- **${ep.name}** (${ep.member})${provider}`);
      if (ep.consumers.length === 0) {
        lines.push("  - no consumers in other services");
      }
      for (const c of ep.consumers) {
        const details = [c.member, c.via ? `via ${c.via}` : null, formatConfidence(c.confidence)]
          .filter(Boolean)
          .join(", ");
        lines.push(`  - consumer \`${c.evidence ?? c.filePath ?? c.nodeId}\` (${details})`);
      }
    }
    lines.push("");
  }

  if (impact.outbound.length > 0) {
    lines.push(`### Calls from changed files to other services (${impact.outbound.length})`, "");
    for (const o of impact.outbound) {
      lines.push(
        `- \`${o.evidence ?? o.nodeId}\` → **${o.endpointName}** (${o.endpointMember})`,
      );
    }
    lines.push("");
  }

  const section = (title: string, list: TouchedContract[]) => {
    if (list.length === 0) return;
    lines.push(`### ${title} (${list.length})`, "");
    for (const c of list) {
      lines.push(`- **${c.name}** — touched by ${c.touchedBy.map(touchLabel).join(", ")}`);
      if (c.counterparts.length === 0) lines.push("  - no other service on it");
      for (const t of c.counterparts) lines.push(`  - ${touchLabel(t)}`);
    }
    lines.push("");
  };
  section("Message channels touched", impact.channels);
  section("Shared tables touched", impact.tables);

  if (impact.affectedMembers.length > 0) {
    lines.push(`Services affected: ${impact.affectedMembers.join(", ")}`, "");
  }
  return lines.join("\n");
}

// ── Dashboard diff overlay ─────────────────────────────────────────────────

export interface WorkspaceDiffOverlay {
  version: "1.0.0";
  baseBranch: string;
  generatedAt: string;
  workspace: true;
  changedFiles: string[];
  changedNodeIds: string[];
  /** 1-hop neighbours of changed nodes plus every cross-service consumer. */
  affectedNodeIds: string[];
  /** Subset of affectedNodeIds that live in other services (contract consumers). */
  crossServiceNodeIds: string[];
}

/**
 * `diff-overlay.json` for a workspace diff. `changes` maps member name →
 * changed paths relative to that member root.
 */
export function buildWorkspaceDiffOverlay(
  graph: GraphLike,
  changes: Record<string, readonly string[]>,
  opts: { baseBranch?: string; generatedAt?: string } = {},
): WorkspaceDiffOverlay {
  const changedFiles: string[] = [];
  for (const [member, files] of Object.entries(changes)) {
    changedFiles.push(...namespaceChangedFiles(member, files));
  }
  const files = new Set(changedFiles);
  const changed = changedNodeIdsFor(graph, files);
  const affected = new Set<string>();
  for (const e of graph.edges) {
    const s = changed.has(e.source);
    const t = changed.has(e.target);
    if (s && !t) affected.add(e.target);
    if (t && !s) affected.add(e.source);
  }
  const impact = buildCrossServiceImpact(graph, changedFiles);
  const cross = (impact?.consumerNodeIds ?? []).filter((id) => !changed.has(id));
  for (const id of cross) affected.add(id);
  return {
    version: "1.0.0",
    baseBranch: opts.baseBranch ?? "",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    workspace: true,
    changedFiles,
    changedNodeIds: [...changed].sort(),
    affectedNodeIds: [...affected].sort(),
    crossServiceNodeIds: cross,
  };
}

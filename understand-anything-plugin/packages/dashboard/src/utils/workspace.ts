/**
 * Dashboard-side helpers for multi-repo workspace graphs. Graph semantics
 * (member resolution, service aggregation, endpoint consumers) live in the
 * browser-safe `@understand-anything/core/workspace` module; this file only
 * adds presentation concerns (colors, sizes, labels, view-mode availability,
 * diff-overlay parsing).
 */
import type { Edge, Node } from "@xyflow/react";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import {
  buildServiceGraph,
  getWorkspaceMemberNames,
  memberOfId,
  type ServiceLink,
} from "@understand-anything/core/workspace";

/** Fixed palette — distinguishable on both dark and light themes. */
export const SERVICE_PALETTE: readonly string[] = [
  "#d4a574", // amber
  "#6fa8dc", // blue
  "#8fc98f", // green
  "#c97070", // red
  "#b08fd8", // violet
  "#5fc4c0", // teal
  "#e0b85a", // gold
  "#d88fb8", // pink
  "#9fb06a", // olive
  "#7f9fe0", // periwinkle
  "#e0905a", // orange
  "#a0a0b8", // slate
];

/** FNV-1a — stable color per member name, independent of manifest order. */
export function memberColor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SERVICE_PALETTE[(h >>> 0) % SERVICE_PALETTE.length];
}

export type StructuralViewMode = "services" | "domain" | "structural";

/**
 * Buttons of the header view toggle. Non-workspace graphs keep the previous
 * behaviour exactly: Domain|Structural only when a domain graph exists.
 */
export function availableViewModes(opts: {
  hasGraph: boolean;
  isKnowledgeGraph: boolean;
  hasDomainGraph: boolean;
  isWorkspace: boolean;
}): StructuralViewMode[] {
  if (!opts.hasGraph || opts.isKnowledgeGraph) return [];
  const modes: StructuralViewMode[] = [];
  if (opts.isWorkspace) modes.push("services");
  if (opts.hasDomainGraph) modes.push("domain");
  if (modes.length === 0) return [];
  modes.push("structural");
  return modes;
}

export interface ParsedDiffOverlay {
  changed: string[];
  /** Includes every cross-service consumer. */
  affected: string[];
  crossService: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parse `diff-overlay.json`. The classic shape has changedNodeIds /
 * affectedNodeIds; a workspace overlay adds `crossServiceNodeIds`
 * (consumers in other services), which are folded into `affected` too.
 */
export function parseDiffOverlay(data: unknown): ParsedDiffOverlay | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.changedNodeIds) || !Array.isArray(d.affectedNodeIds)) return null;
  const changed = strings(d.changedNodeIds);
  const affected = strings(d.affectedNodeIds);
  const crossService = strings(d.crossServiceNodeIds);
  const seen = new Set(affected);
  for (const id of crossService) {
    if (!seen.has(id)) {
      seen.add(id);
      affected.push(id);
    }
  }
  return { changed, affected, crossService };
}

/** Shared (member-less) nodes are always visible. */
export function isNodeInVisibleMembers(
  id: string,
  members: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): boolean {
  if (hidden.size === 0) return true;
  const m = memberOfId(id, members);
  return m === null || !hidden.has(m);
}

export type ServiceDiffStatus = "changed" | "impacted";

/** Per member: "changed" when it holds changed nodes, else "impacted" when it holds cross-service consumers. */
export function serviceDiffStatus(
  graph: KnowledgeGraph,
  changedNodeIds: ReadonlySet<string>,
  crossServiceNodeIds: ReadonlySet<string>,
): Map<string, ServiceDiffStatus> {
  const members = new Set(getWorkspaceMemberNames(graph));
  const out = new Map<string, ServiceDiffStatus>();
  for (const id of changedNodeIds) {
    const m = memberOfId(id, members);
    if (m) out.set(m, "changed");
  }
  for (const id of crossServiceNodeIds) {
    const m = memberOfId(id, members);
    if (m && !out.has(m)) out.set(m, "impacted");
  }
  return out;
}

export interface ServiceLinkLabels {
  calls: string;
  messages: string;
  tables: string;
}

export function formatServiceLinkLabel(link: ServiceLink, labels: ServiceLinkLabels): string {
  const parts: string[] = [];
  if (link.calls > 0) parts.push(`${labels.calls} ${link.calls}`);
  if (link.messages > 0) parts.push(`${labels.messages} ${link.messages}`);
  if (link.tables > 0) parts.push(`${labels.tables} ${link.tables}`);
  return parts.join(" · ");
}

export interface ServiceNodeData extends Record<string, unknown> {
  member: string;
  fileCount: number;
  nodeCount: number;
  color: string;
  diffStatus: ServiceDiffStatus | null;
  incoming: number;
  outgoing: number;
}

export const SERVICE_NODE_MIN_WIDTH = 200;
export const SERVICE_NODE_MAX_WIDTH = 380;

/** Width/height grow with sqrt(fileCount) relative to the largest member. */
export function serviceNodeSize(fileCount: number, maxFileCount: number): { width: number; height: number } {
  const ratio = maxFileCount > 0 ? Math.sqrt(fileCount / maxFileCount) : 0;
  const width = Math.round(SERVICE_NODE_MIN_WIDTH + (SERVICE_NODE_MAX_WIDTH - SERVICE_NODE_MIN_WIDTH) * ratio);
  const height = Math.round(width * 0.45);
  return { width, height };
}

export interface ServiceFlow {
  nodes: Node<ServiceNodeData, "service">[];
  edges: Edge[];
  dims: Map<string, { width: number; height: number }>;
  linkCount: number;
}

export const serviceNodeId = (member: string): string => `service:${member}`;

/** React Flow nodes/edges (pre-layout) for the services view. */
export function buildServiceFlow(
  graph: KnowledgeGraph,
  opts: {
    labels: ServiceLinkLabels;
    diffMode: boolean;
    changedNodeIds: ReadonlySet<string>;
    crossServiceNodeIds: ReadonlySet<string>;
  },
): ServiceFlow {
  const { services, links } = buildServiceGraph(graph);
  const status = opts.diffMode
    ? serviceDiffStatus(graph, opts.changedNodeIds, opts.crossServiceNodeIds)
    : new Map<string, ServiceDiffStatus>();
  const maxFiles = Math.max(0, ...services.map((s) => s.fileCount));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const l of links) {
    const total = l.calls + l.messages + l.tables;
    outgoing.set(l.source, (outgoing.get(l.source) ?? 0) + total);
    incoming.set(l.target, (incoming.get(l.target) ?? 0) + total);
  }

  const dims = new Map<string, { width: number; height: number }>();
  const nodes = services.map((s) => {
    const id = serviceNodeId(s.name);
    const size = serviceNodeSize(s.fileCount, maxFiles);
    dims.set(id, size);
    return {
      id,
      type: "service" as const,
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data: {
        member: s.name,
        fileCount: s.fileCount,
        nodeCount: s.nodeCount,
        color: memberColor(s.name),
        diffStatus: status.get(s.name) ?? null,
        incoming: incoming.get(s.name) ?? 0,
        outgoing: outgoing.get(s.name) ?? 0,
      },
    };
  });

  const edges: Edge[] = links.map((l) => {
    const total = l.calls + l.messages + l.tables;
    const asyncOnly = l.calls === 0;
    return {
      id: `svc-${l.source}->${l.target}`,
      source: serviceNodeId(l.source),
      target: serviceNodeId(l.target),
      label: formatServiceLinkLabel(l, opts.labels),
      style: {
        stroke: memberColor(l.source),
        strokeOpacity: 0.75,
        strokeWidth: Math.min(1.5 + Math.log2(total + 1), 6),
        ...(asyncOnly ? { strokeDasharray: "6 4" } : {}),
      },
      labelStyle: { fill: "var(--color-text-secondary)", fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: "var(--color-surface)", fillOpacity: 0.92 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    };
  });

  return { nodes, edges, dims, linkCount: links.length };
}

/** `{name}` placeholders → values (missing keys are left as-is). */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

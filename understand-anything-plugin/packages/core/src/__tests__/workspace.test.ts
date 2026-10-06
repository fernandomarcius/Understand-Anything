import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "../types.js";
import { validateGraph } from "../schema.js";
import {
  buildCrossServiceImpact,
  buildServiceGraph,
  buildWorkspaceDiffOverlay,
  formatCrossServiceImpact,
  getEndpointConsumers,
  getWorkspaceMemberNames,
  memberOfId,
  memberOfNode,
  namespaceChangedFiles,
} from "../workspace.js";

function node(id: string, type: GraphNode["type"], filePath?: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type,
    name: extra.name ?? id.split("/").pop() ?? id,
    ...(filePath ? { filePath } : {}),
    summary: "",
    tags: extra.tags ?? [],
    complexity: "simple",
    ...extra,
  };
}

function edge(source: string, target: string, type: GraphEdge["type"], extra: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, type, direction: "forward", weight: 0.8, ...extra };
}

const EP = "endpoint:brain/src/Api.cs:GET /api/ops";

/**
 * Fixture workspace: brain exposes GET /api/ops (consumed by web and motor),
 * publishes a codeq channel motor subscribes to, and writes a table motor reads.
 */
export function workspaceGraph(): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "cloudbi",
      languages: ["csharp", "javascript", "python"],
      frameworks: [],
      description: "Workspace of 3 services: brain, motor, web",
      analyzedAt: "2026-10-06T00:00:00.000Z",
      gitCommitHash: "ws:abc",
      workspace: {
        name: "cloudbi",
        members: [
          { name: "brain", path: "../brain", gitCommitHash: "b1", analyzedAt: "x", nodes: 6, edges: 1 },
          { name: "motor", path: "../motor", gitCommitHash: "m1", analyzedAt: "x", nodes: 3, edges: 0 },
          { name: "web", path: "../web", gitCommitHash: "w1", analyzedAt: "x", nodes: 2, edges: 0 },
        ],
      },
    },
    nodes: [
      node("file:brain/src/Api.cs", "file", "brain/src/Api.cs"),
      node("function:brain/src/Api.cs:Get", "function", "brain/src/Api.cs"),
      node("file:brain/src/Internal.cs", "file", "brain/src/Internal.cs"),
      node("file:brain/src/Pub.cs", "file", "brain/src/Pub.cs"),
      node("file:brain/src/Repo.cs", "file", "brain/src/Repo.cs"),
      node("config:brain/appsettings.json", "config", "brain/appsettings.json"),
      node("file:motor/src/job.py", "file", "motor/src/job.py"),
      node("file:motor/src/worker.py", "file", "motor/src/worker.py"),
      node("file:motor/src/report.py", "file", "motor/src/report.py"),
      node("file:web/src/client.js", "file", "web/src/client.js"),
      node("file:web/src/App.jsx", "file", "web/src/App.jsx"),
      node(EP, "endpoint", "brain/src/Api.cs", { name: "GET /api/ops", tags: ["endpoint", "http", "contract"] }),
      node("concept:codeq/relatorio", "concept", undefined, { name: "relatorio", tags: ["message-channel", "contract", "codeq"] }),
      node("table:workspace/dbo.LOG", "table", undefined, { name: "dbo.LOG", tags: ["table", "shared-data", "contract"] }),
    ],
    edges: [
      edge("file:brain/src/Api.cs", "function:brain/src/Api.cs:Get", "contains"),
      edge("file:brain/src/Api.cs", EP, "routes"),
      edge("file:web/src/client.js", EP, "calls", {
        crossService: true,
        confidence: 0.9,
        evidence: { consumer: "web/src/client.js:17", provider: "brain/src/Api.cs:68", via: "axios" },
      }),
      edge("file:motor/src/job.py", EP, "calls", {
        crossService: true,
        confidence: 0.72,
        evidence: { consumer: "motor/src/job.py:5", provider: "brain/src/Api.cs:68", via: "requests" },
      }),
      // same-member call: not a cross-service consumer
      edge("file:brain/src/Internal.cs", EP, "calls"),
      edge("file:web/src/App.jsx", "file:web/src/client.js", "imports"),
      edge("file:brain/src/Pub.cs", "concept:codeq/relatorio", "publishes"),
      edge("file:motor/src/worker.py", "concept:codeq/relatorio", "subscribes"),
      edge("file:brain/src/Repo.cs", "table:workspace/dbo.LOG", "writes_to"),
      edge("file:motor/src/report.py", "table:workspace/dbo.LOG", "reads_from"),
    ],
    layers: [
      { id: "layer:brain/api", name: "brain · API", description: "", nodeIds: ["file:brain/src/Api.cs"] },
      { id: "layer:web/ui", name: "web · UI", description: "", nodeIds: ["file:web/src/client.js", "file:web/src/App.jsx"] },
    ],
    tour: [],
  };
}

const MEMBERS = new Set(["brain", "motor", "web"]);

describe("workspace member helpers", () => {
  it("lists member names in manifest order, empty for non-workspace graphs", () => {
    expect(getWorkspaceMemberNames(workspaceGraph())).toEqual(["brain", "motor", "web"]);
    const plain = workspaceGraph();
    delete plain.project.workspace;
    expect(getWorkspaceMemberNames(plain)).toEqual([]);
    expect(getWorkspaceMemberNames(null)).toEqual([]);
  });

  it("resolves the member from any namespaced id", () => {
    expect(memberOfId("file:brain/src/Api.cs", MEMBERS)).toBe("brain");
    expect(memberOfId("function:motor/src/job.py:run", MEMBERS)).toBe("motor");
    expect(memberOfId("layer:web/ui", MEMBERS)).toBe("web");
    expect(memberOfId(EP, MEMBERS)).toBe("brain");
    expect(memberOfId("web/legacy-id", MEMBERS)).toBe("web");
    expect(memberOfId("file:other/x.ts", MEMBERS)).toBeNull();
    expect(memberOfId("table:workspace/dbo.LOG", MEMBERS)).toBeNull();
    expect(memberOfId("file:brain", MEMBERS)).toBeNull();
  });

  it("treats linker-generated channel and table nodes as shared even when a member shares their prefix", () => {
    const members = new Set(["codeq", "workspace"]);
    const channel = node("concept:codeq/x", "concept", undefined, { tags: ["message-channel", "contract"] });
    const table = node("table:workspace/dbo.T", "table", undefined, { tags: ["shared-data", "contract"] });
    expect(memberOfNode(channel, members)).toBeNull();
    expect(memberOfNode(table, members)).toBeNull();
    expect(memberOfNode(node("concept:codeq/own", "concept"), members)).toBe("codeq");
  });

  it("namespaces member-relative changed paths", () => {
    expect(namespaceChangedFiles("brain", ["src/Api.cs", "./a/b.ts", "c\\d.cs", ""])).toEqual([
      "brain/src/Api.cs",
      "brain/a/b.ts",
      "brain/c/d.cs",
    ]);
  });
});

describe("buildServiceGraph", () => {
  it("returns one service per member with file-level counts", () => {
    const { services } = buildServiceGraph(workspaceGraph());
    expect(services).toEqual([
      { name: "brain", fileCount: 5, nodeCount: 7 },
      { name: "motor", fileCount: 3, nodeCount: 3 },
      { name: "web", fileCount: 2, nodeCount: 2 },
    ]);
  });

  it("aggregates calls, shared channels and shared tables between members", () => {
    const { links } = buildServiceGraph(workspaceGraph());
    expect(links).toEqual([
      { source: "brain", target: "motor", calls: 0, messages: 1, tables: 1 },
      { source: "motor", target: "brain", calls: 1, messages: 0, tables: 0 },
      { source: "web", target: "brain", calls: 1, messages: 0, tables: 0 },
    ]);
  });

  it("returns nothing for non-workspace graphs", () => {
    const plain = workspaceGraph();
    delete plain.project.workspace;
    expect(buildServiceGraph(plain)).toEqual({ services: [], links: [] });
  });
});

describe("getEndpointConsumers", () => {
  it("lists consumers from other members with evidence, ignoring same-member callers", () => {
    expect(getEndpointConsumers(workspaceGraph(), EP)).toEqual([
      {
        endpointId: EP,
        nodeId: "file:motor/src/job.py",
        member: "motor",
        filePath: "motor/src/job.py",
        evidence: "motor/src/job.py:5",
        confidence: 0.72,
        via: "requests",
      },
      {
        endpointId: EP,
        nodeId: "file:web/src/client.js",
        member: "web",
        filePath: "web/src/client.js",
        evidence: "web/src/client.js:17",
        confidence: 0.9,
        via: "axios",
      },
    ]);
  });

  it("returns [] for unknown endpoints and non-workspace graphs", () => {
    expect(getEndpointConsumers(workspaceGraph(), "endpoint:nope")).toEqual([]);
    const plain = workspaceGraph();
    delete plain.project.workspace;
    expect(getEndpointConsumers(plain, EP)).toEqual([]);
  });
});

describe("buildCrossServiceImpact", () => {
  it("maps a provider change to the endpoint and its consumers in other services", () => {
    const impact = buildCrossServiceImpact(workspaceGraph(), namespaceChangedFiles("brain", ["src/Api.cs"]));
    expect(impact).not.toBeNull();
    expect(impact!.endpoints).toHaveLength(1);
    expect(impact!.endpoints[0]).toMatchObject({
      id: EP,
      name: "GET /api/ops",
      member: "brain",
      providerFile: "brain/src/Api.cs",
    });
    expect(impact!.endpoints[0].consumers.map((c) => c.evidence)).toEqual([
      "motor/src/job.py:5",
      "web/src/client.js:17",
    ]);
    expect(impact!.consumerNodeIds).toEqual(["file:motor/src/job.py", "file:web/src/client.js"]);
    expect(impact!.affectedMembers).toEqual(["motor", "web"]);
    expect(impact!.channels).toEqual([]);
    expect(impact!.tables).toEqual([]);
  });

  it("detects endpoints of a deleted/renamed provider file through the endpoint id", () => {
    const g = workspaceGraph();
    g.edges = g.edges.filter((e) => e.type !== "routes");
    g.nodes = g.nodes.map((n) => (n.id === EP ? { ...n, filePath: undefined } : n));
    const impact = buildCrossServiceImpact(g, ["brain/src/Api.cs"]);
    expect(impact!.endpoints.map((e) => e.id)).toEqual([EP]);
  });

  it("reports channels and shared tables touched, with counterparts in other members", () => {
    const impact = buildCrossServiceImpact(workspaceGraph(), ["brain/src/Pub.cs", "brain/src/Repo.cs"])!;
    expect(impact.endpoints).toEqual([]);
    expect(impact.channels).toEqual([
      {
        id: "concept:codeq/relatorio",
        name: "relatorio",
        touchedBy: [{ nodeId: "file:brain/src/Pub.cs", member: "brain", role: "publishes", filePath: "brain/src/Pub.cs" }],
        counterparts: [
          { nodeId: "file:motor/src/worker.py", member: "motor", role: "subscribes", filePath: "motor/src/worker.py" },
        ],
      },
    ]);
    expect(impact.tables).toEqual([
      {
        id: "table:workspace/dbo.LOG",
        name: "dbo.LOG",
        touchedBy: [{ nodeId: "file:brain/src/Repo.cs", member: "brain", role: "writes_to", filePath: "brain/src/Repo.cs" }],
        counterparts: [
          { nodeId: "file:motor/src/report.py", member: "motor", role: "reads_from", filePath: "motor/src/report.py" },
        ],
      },
    ]);
    expect(impact.consumerNodeIds).toEqual(["file:motor/src/report.py", "file:motor/src/worker.py"]);
    expect(impact.affectedMembers).toEqual(["motor"]);
  });

  it("lists outbound calls from a changed consumer to other services", () => {
    const impact = buildCrossServiceImpact(workspaceGraph(), ["web/src/client.js"])!;
    expect(impact.endpoints).toEqual([]);
    expect(impact.outbound).toEqual([
      {
        nodeId: "file:web/src/client.js",
        member: "web",
        endpointId: EP,
        endpointName: "GET /api/ops",
        endpointMember: "brain",
        evidence: "web/src/client.js:17",
      },
    ]);
    expect(impact.affectedMembers).toEqual(["brain"]);
  });

  it("is null for non-workspace graphs and empty when nothing crosses a service boundary", () => {
    const plain = workspaceGraph();
    delete plain.project.workspace;
    expect(buildCrossServiceImpact(plain, ["brain/src/Api.cs"])).toBeNull();
    const impact = buildCrossServiceImpact(workspaceGraph(), ["web/src/App.jsx"])!;
    expect(impact.endpoints).toEqual([]);
    expect(impact.outbound).toEqual([]);
    expect(impact.consumerNodeIds).toEqual([]);
  });
});

describe("formatCrossServiceImpact", () => {
  it("renders endpoints, consumers with file:line evidence, channels and tables", () => {
    const g = workspaceGraph();
    const md = formatCrossServiceImpact(
      buildCrossServiceImpact(g, ["brain/src/Api.cs", "brain/src/Pub.cs", "brain/src/Repo.cs"])!,
    );
    expect(md).toContain("## Cross-Service Impact");
    expect(md).toContain("**GET /api/ops** (brain)");
    expect(md).toContain("`web/src/client.js:17` (web, via axios, confidence 0.9)");
    expect(md).toContain("`motor/src/job.py:5` (motor, via requests, confidence 0.72)");
    expect(md).toContain("**relatorio**");
    expect(md).toContain("**dbo.LOG**");
    expect(md).toContain("Services affected: motor, web");
  });

  it("says so when there is no cross-service impact", () => {
    const md = formatCrossServiceImpact(buildCrossServiceImpact(workspaceGraph(), ["web/src/App.jsx"])!);
    expect(md).toContain("No cross-service impact detected.");
  });
});

describe("buildWorkspaceDiffOverlay", () => {
  it("builds a dashboard overlay whose affected set includes consumers in other services", () => {
    const overlay = buildWorkspaceDiffOverlay(
      workspaceGraph(),
      { brain: ["src/Api.cs"] },
      { baseBranch: "main", generatedAt: "2026-10-06T00:00:00.000Z" },
    );
    expect(overlay).toEqual({
      version: "1.0.0",
      baseBranch: "main",
      generatedAt: "2026-10-06T00:00:00.000Z",
      workspace: true,
      changedFiles: ["brain/src/Api.cs"],
      changedNodeIds: [EP, "file:brain/src/Api.cs", "function:brain/src/Api.cs:Get"],
      affectedNodeIds: ["file:brain/src/Internal.cs", "file:motor/src/job.py", "file:web/src/client.js"],
      crossServiceNodeIds: ["file:motor/src/job.py", "file:web/src/client.js"],
    });
  });
});

describe("schema keeps cross-service edge metadata", () => {
  it("preserves crossService, confidence and evidence through validateGraph", () => {
    const result = validateGraph(workspaceGraph());
    expect(result.success).toBe(true);
    const call = result.data!.edges.find((e) => e.source === "file:web/src/client.js" && e.type === "calls")!;
    expect(call.crossService).toBe(true);
    expect(call.confidence).toBe(0.9);
    expect(call.evidence).toMatchObject({ consumer: "web/src/client.js:17", via: "axios" });
  });

  it("drops malformed cross-service metadata without dropping the edge", () => {
    const g = workspaceGraph() as unknown as { edges: Record<string, unknown>[] };
    g.edges[2] = { ...g.edges[2], crossService: "yes", confidence: "high", evidence: "nope" };
    const result = validateGraph(g);
    const call = result.data!.edges.find((e) => e.source === "file:web/src/client.js" && e.type === "calls")!;
    expect(call).toBeDefined();
    expect(call.crossService).toBeUndefined();
    expect(call.confidence).toBeUndefined();
    expect(call.evidence).toBeUndefined();
  });
});

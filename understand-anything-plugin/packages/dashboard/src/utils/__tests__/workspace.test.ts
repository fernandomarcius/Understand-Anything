import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import {
  availableViewModes,
  buildServiceFlow,
  formatServiceLinkLabel,
  isNodeInVisibleMembers,
  memberColor,
  parseDiffOverlay,
  serviceDiffStatus,
  SERVICE_PALETTE,
} from "../workspace";

function node(id: string, type: GraphNode["type"], filePath?: string, tags: string[] = []): GraphNode {
  return { id, type, name: id, ...(filePath ? { filePath } : {}), summary: "", tags, complexity: "simple" };
}
function edge(source: string, target: string, type: GraphEdge["type"], extra: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, type, direction: "forward", weight: 1, ...extra };
}

const EP = "endpoint:brain/src/Api.cs:GET /api/ops";

export function workspaceFixture(): KnowledgeGraph {
  return {
    version: "1.0.0",
    project: {
      name: "cloudbi",
      languages: [],
      frameworks: [],
      description: "",
      analyzedAt: "x",
      gitCommitHash: "ws:1",
      workspace: {
        name: "cloudbi",
        members: [
          { name: "brain", path: "../brain", gitCommitHash: "a", analyzedAt: "x", nodes: 3, edges: 1 },
          { name: "motor", path: "../motor", gitCommitHash: "b", analyzedAt: "x", nodes: 2, edges: 0 },
          { name: "web", path: "../web", gitCommitHash: "c", analyzedAt: "x", nodes: 1, edges: 0 },
        ],
      },
    },
    nodes: [
      node("file:brain/src/Api.cs", "file", "brain/src/Api.cs"),
      node("file:brain/src/Pub.cs", "file", "brain/src/Pub.cs"),
      node(EP, "endpoint", "brain/src/Api.cs", ["contract"]),
      node("file:motor/src/job.py", "file", "motor/src/job.py"),
      node("file:motor/src/worker.py", "file", "motor/src/worker.py"),
      node("file:web/src/client.js", "file", "web/src/client.js"),
      node("concept:codeq/rel", "concept", undefined, ["contract", "message-channel"]),
    ],
    edges: [
      edge("file:brain/src/Api.cs", EP, "routes"),
      edge("file:web/src/client.js", EP, "calls", { crossService: true, confidence: 0.9, evidence: { consumer: "web/src/client.js:3" } }),
      edge("file:motor/src/job.py", EP, "calls", { crossService: true }),
      edge("file:brain/src/Pub.cs", "concept:codeq/rel", "publishes"),
      edge("file:motor/src/worker.py", "concept:codeq/rel", "subscribes"),
    ],
    layers: [
      { id: "layer:brain/api", name: "brain · API", description: "", nodeIds: ["file:brain/src/Api.cs"] },
    ],
    tour: [],
  };
}

const LABELS = { calls: "calls", messages: "messages", tables: "tables" };

describe("memberColor", () => {
  it("is stable per member name and independent of manifest order", () => {
    expect(memberColor("brain")).toBe(memberColor("brain"));
    expect(SERVICE_PALETTE).toContain(memberColor("brain"));
    expect(SERVICE_PALETTE).toContain(memberColor("motor"));
  });

  it("spreads common names across the palette", () => {
    const colors = new Set(["brain", "motor", "web", "gestao", "api", "worker"].map(memberColor));
    expect(colors.size).toBeGreaterThan(3);
  });
});

describe("availableViewModes", () => {
  it("keeps the non-workspace toggle exactly as before", () => {
    expect(availableViewModes({ hasGraph: true, isKnowledgeGraph: false, hasDomainGraph: true, isWorkspace: false }))
      .toEqual(["domain", "structural"]);
    expect(availableViewModes({ hasGraph: true, isKnowledgeGraph: false, hasDomainGraph: false, isWorkspace: false }))
      .toEqual([]);
    expect(availableViewModes({ hasGraph: false, isKnowledgeGraph: false, hasDomainGraph: true, isWorkspace: false }))
      .toEqual([]);
  });

  it("offers the services view first for workspace graphs", () => {
    expect(availableViewModes({ hasGraph: true, isKnowledgeGraph: false, hasDomainGraph: false, isWorkspace: true }))
      .toEqual(["services", "structural"]);
    expect(availableViewModes({ hasGraph: true, isKnowledgeGraph: false, hasDomainGraph: true, isWorkspace: true }))
      .toEqual(["services", "domain", "structural"]);
    expect(availableViewModes({ hasGraph: true, isKnowledgeGraph: true, hasDomainGraph: false, isWorkspace: true }))
      .toEqual([]);
  });
});

describe("parseDiffOverlay", () => {
  it("parses the classic overlay with no cross-service ids", () => {
    expect(parseDiffOverlay({ changedNodeIds: ["a"], affectedNodeIds: ["b"] })).toEqual({
      changed: ["a"],
      affected: ["b"],
      crossService: [],
    });
  });

  it("parses the workspace overlay and keeps consumers in the affected set", () => {
    expect(
      parseDiffOverlay({
        workspace: true,
        changedNodeIds: ["a"],
        affectedNodeIds: ["b"],
        crossServiceNodeIds: ["c", 3, "b"],
      }),
    ).toEqual({ changed: ["a"], affected: ["b", "c"], crossService: ["c", "b"] });
  });

  it("rejects malformed payloads", () => {
    expect(parseDiffOverlay(null)).toBeNull();
    expect(parseDiffOverlay({ changedNodeIds: "a", affectedNodeIds: [] })).toBeNull();
    expect(parseDiffOverlay({ changedNodeIds: [] })).toBeNull();
  });
});

describe("isNodeInVisibleMembers", () => {
  const members = new Set(["brain", "motor", "web"]);
  it("hides only nodes of hidden members; shared nodes stay visible", () => {
    const hidden = new Set(["motor"]);
    expect(isNodeInVisibleMembers("file:brain/a", members, hidden)).toBe(true);
    expect(isNodeInVisibleMembers("file:motor/a", members, hidden)).toBe(false);
    expect(isNodeInVisibleMembers("layer:motor/x", members, hidden)).toBe(false);
    expect(isNodeInVisibleMembers("table:workspace/dbo.T", members, hidden)).toBe(true);
    expect(isNodeInVisibleMembers("file:motor/a", members, new Set())).toBe(true);
  });
});

describe("serviceDiffStatus", () => {
  it("marks services with changed nodes and services reached through contracts", () => {
    const status = serviceDiffStatus(
      workspaceFixture(),
      new Set(["file:brain/src/Api.cs"]),
      new Set(["file:web/src/client.js", "file:motor/src/job.py"]),
    );
    expect(Object.fromEntries(status)).toEqual({ brain: "changed", motor: "impacted", web: "impacted" });
  });
});

describe("formatServiceLinkLabel", () => {
  it("lists non-zero kinds with counts", () => {
    expect(formatServiceLinkLabel({ source: "a", target: "b", calls: 3, messages: 0, tables: 2 }, LABELS))
      .toBe("calls 3 · tables 2");
  });
});

describe("buildServiceFlow", () => {
  it("builds one node per member sized by file count and aggregated labelled edges", () => {
    const flow = buildServiceFlow(workspaceFixture(), {
      labels: LABELS,
      diffMode: false,
      changedNodeIds: new Set(),
      crossServiceNodeIds: new Set(),
    });
    expect(flow.nodes.map((n) => n.id)).toEqual(["service:brain", "service:motor", "service:web"]);
    const brain = flow.nodes[0];
    expect(brain.data).toMatchObject({ member: "brain", fileCount: 2, color: memberColor("brain"), diffStatus: null });
    const sizes = Object.fromEntries(flow.nodes.map((n) => [n.id, flow.dims.get(n.id)!.width]));
    expect(sizes["service:brain"]).toBeGreaterThan(sizes["service:web"]);
    expect(flow.edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ["service:brain", "service:motor", "messages 1"],
      ["service:motor", "service:brain", "calls 1"],
      ["service:web", "service:brain", "calls 1"],
    ]);
  });

  it("flags diff status on service nodes when diff mode is on", () => {
    const flow = buildServiceFlow(workspaceFixture(), {
      labels: LABELS,
      diffMode: true,
      changedNodeIds: new Set(["file:brain/src/Api.cs"]),
      crossServiceNodeIds: new Set(["file:web/src/client.js"]),
    });
    expect(flow.nodes.map((n) => n.data.diffStatus)).toEqual(["changed", null, "impacted"]);
  });
});

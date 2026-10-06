import { describe, it, expect } from "vitest";
import { buildDiffContext, formatDiffAnalysis } from "../diff-analyzer.js";
import type { KnowledgeGraph } from "@understand-anything/core";

const sampleGraph: KnowledgeGraph = {
  version: "1.0.0",
  project: {
    name: "test-project",
    languages: ["typescript"],
    frameworks: ["express"],
    description: "A test project",
    analyzedAt: "2026-03-14T00:00:00Z",
    gitCommitHash: "abc123",
  },
  nodes: [
    { id: "file:src/index.ts", type: "file", name: "index.ts", filePath: "src/index.ts", summary: "Entry point", tags: ["entry"], complexity: "simple" },
    { id: "file:src/routes.ts", type: "file", name: "routes.ts", filePath: "src/routes.ts", summary: "Routes", tags: ["routes"], complexity: "moderate" },
    { id: "file:src/service.ts", type: "file", name: "service.ts", filePath: "src/service.ts", summary: "Service", tags: ["service"], complexity: "complex" },
    { id: "function:src/service.ts:process", type: "function", name: "process", filePath: "src/service.ts", lineRange: [10, 30], summary: "Process function", tags: ["core"], complexity: "complex" },
    { id: "file:src/db.ts", type: "file", name: "db.ts", filePath: "src/db.ts", summary: "Database", tags: ["db"], complexity: "simple" },
  ],
  edges: [
    { source: "file:src/index.ts", target: "file:src/routes.ts", type: "imports", direction: "forward", weight: 0.9 },
    { source: "file:src/routes.ts", target: "file:src/service.ts", type: "calls", direction: "forward", weight: 0.8 },
    { source: "file:src/service.ts", target: "function:src/service.ts:process", type: "contains", direction: "forward", weight: 1.0 },
    { source: "file:src/service.ts", target: "file:src/db.ts", type: "reads_from", direction: "forward", weight: 0.7 },
  ],
  layers: [
    { id: "layer:api", name: "API Layer", description: "HTTP routes", nodeIds: ["file:src/index.ts", "file:src/routes.ts"] },
    { id: "layer:service", name: "Service Layer", description: "Business logic", nodeIds: ["file:src/service.ts", "function:src/service.ts:process"] },
    { id: "layer:data", name: "Data Layer", description: "Database", nodeIds: ["file:src/db.ts"] },
  ],
  tour: [],
};

describe("diff-analyzer", () => {
  describe("buildDiffContext", () => {
    it("identifies directly changed nodes", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      expect(ctx.changedNodes.map((n) => n.id)).toContain("file:src/service.ts");
    });

    it("identifies child nodes of changed files", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      expect(ctx.changedNodes.map((n) => n.id)).toContain("function:src/service.ts:process");
    });

    it("identifies affected nodes via edges (1-hop)", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      expect(ctx.affectedNodes.map((n) => n.id)).toContain("file:src/routes.ts");
      expect(ctx.affectedNodes.map((n) => n.id)).toContain("file:src/db.ts");
    });

    it("identifies affected layers", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      expect(ctx.affectedLayers.map((l) => l.name)).toContain("Service Layer");
    });

    it("identifies impacted edges", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      expect(ctx.impactedEdges.length).toBeGreaterThan(0);
    });

    it("handles files not in the graph gracefully", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/unknown.ts"]);
      expect(ctx.changedNodes).toHaveLength(0);
      expect(ctx.unmappedFiles).toContain("src/unknown.ts");
    });

    it("handles empty diff", () => {
      const ctx = buildDiffContext(sampleGraph, []);
      expect(ctx.changedNodes).toHaveLength(0);
      expect(ctx.affectedNodes).toHaveLength(0);
    });

    it("de-duplicates affected nodes (not in changed set)", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      const changedIds = new Set(ctx.changedNodes.map((n) => n.id));
      for (const affected of ctx.affectedNodes) {
        expect(changedIds.has(affected.id)).toBe(false);
      }
    });
  });

  describe("formatDiffAnalysis", () => {
    it("produces structured markdown", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      const analysis = formatDiffAnalysis(ctx);
      expect(analysis).toContain("## Changed Components");
      expect(analysis).toContain("## Affected Components");
      expect(analysis).toContain("## Affected Layers");
    });

    it("includes risk assessment section", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
      const analysis = formatDiffAnalysis(ctx);
      expect(analysis).toContain("## Risk Assessment");
    });

    it("lists unmapped files when present", () => {
      const ctx = buildDiffContext(sampleGraph, ["src/unknown.ts"]);
      const analysis = formatDiffAnalysis(ctx);
      expect(analysis).toContain("src/unknown.ts");
    });
  });
});

describe("diff-analyzer — multi-repo workspace", () => {
  const EP = "endpoint:api/src/routes.ts:GET /orders";
  const wsGraph: KnowledgeGraph = {
    version: "1.0.0",
    project: {
      name: "shop",
      languages: ["typescript"],
      frameworks: [],
      description: "Workspace of 2 services: api, web",
      analyzedAt: "2026-10-06T00:00:00Z",
      gitCommitHash: "ws:1",
      workspace: {
        name: "shop",
        members: [
          { name: "api", path: "../api", gitCommitHash: "a", analyzedAt: "x", nodes: 2, edges: 1 },
          { name: "web", path: "../web", gitCommitHash: "w", analyzedAt: "x", nodes: 1, edges: 0 },
        ],
      },
    },
    nodes: [
      { id: "file:api/src/routes.ts", type: "file", name: "routes.ts", filePath: "api/src/routes.ts", summary: "Routes", tags: [], complexity: "moderate" },
      { id: EP, type: "endpoint", name: "GET /orders", filePath: "api/src/routes.ts", summary: "", tags: ["contract"], complexity: "simple" },
      { id: "file:web/src/orders.ts", type: "file", name: "orders.ts", filePath: "web/src/orders.ts", summary: "Client", tags: [], complexity: "simple" },
    ],
    edges: [
      { source: "file:api/src/routes.ts", target: EP, type: "routes", direction: "forward", weight: 1 },
      {
        source: "file:web/src/orders.ts", target: EP, type: "calls", direction: "forward", weight: 0.9,
        crossService: true, confidence: 0.9, evidence: { consumer: "web/src/orders.ts:12", via: "fetch" },
      },
    ],
    layers: [],
    tour: [],
  };

  it("adds the cross-service impact for namespaced changed files", () => {
    const ctx = buildDiffContext(wsGraph, ["api/src/routes.ts"]);
    expect(ctx.crossService?.endpoints.map((e) => e.id)).toEqual([EP]);
    expect(ctx.crossService?.consumerNodeIds).toEqual(["file:web/src/orders.ts"]);
    const analysis = formatDiffAnalysis(ctx);
    expect(analysis).toContain("## Cross-Service Impact");
    expect(analysis).toContain("`web/src/orders.ts:12` (web, via fetch, confidence 0.9)");
    expect(analysis).toContain("**Cross-service impact**: 1 consumer file(s) in 1 other service(s): web");
  });

  it("leaves non-workspace analysis unchanged", () => {
    const ctx = buildDiffContext(sampleGraph, ["src/service.ts"]);
    expect(ctx.crossService).toBeNull();
    expect(formatDiffAnalysis(ctx)).not.toContain("Cross-Service");
  });
});

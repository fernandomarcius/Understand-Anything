import { beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import { useDashboardStore } from "../store";

function graph(workspace: boolean): KnowledgeGraph {
  const n = (id: string, filePath: string) => ({
    id,
    type: "file" as const,
    name: id,
    filePath,
    summary: "",
    tags: [],
    complexity: "simple" as const,
  });
  return {
    version: "1.0.0",
    project: {
      name: "fixture",
      languages: [],
      frameworks: [],
      description: "",
      analyzedAt: "x",
      gitCommitHash: "h",
      ...(workspace
        ? {
            workspace: {
              name: "ws",
              members: [
                { name: "brain", path: "../brain", gitCommitHash: "a", analyzedAt: "x", nodes: 1, edges: 0 },
                { name: "motor", path: "../motor", gitCommitHash: "b", analyzedAt: "x", nodes: 1, edges: 0 },
                { name: "web", path: "../web", gitCommitHash: "c", analyzedAt: "x", nodes: 1, edges: 0 },
              ],
            },
          }
        : {}),
    },
    nodes: [
      n("file:brain/a.cs", "brain/a.cs"),
      n("file:motor/b.py", "motor/b.py"),
      n("file:web/c.js", "web/c.js"),
    ],
    edges: [],
    layers: [
      { id: "layer:brain/api", name: "brain · API", description: "", nodeIds: ["file:brain/a.cs"] },
      { id: "layer:motor/core", name: "motor · Core", description: "", nodeIds: ["file:motor/b.py"] },
      { id: "layer:web/ui", name: "web · UI", description: "", nodeIds: ["file:web/c.js"] },
    ],
    tour: [{ order: 1, title: "t", description: "", nodeIds: ["file:brain/a.cs"] }],
  };
}

beforeEach(() => {
  useDashboardStore.setState(useDashboardStore.getInitialState(), true);
});

describe("store — non-workspace graphs (regression)", () => {
  it("opens in the structural view with no member filter", () => {
    useDashboardStore.getState().setGraph(graph(false));
    const s = useDashboardStore.getState();
    expect(s.viewMode).toBe("structural");
    expect(s.hiddenMembers.size).toBe(0);
    expect(s.hasActiveFilters()).toBe(false);
    expect(s.crossServiceNodeIds.size).toBe(0);
  });

  it("keeps the two-argument diff overlay behaviour", () => {
    useDashboardStore.getState().setDiffOverlay(["a"], ["b"]);
    const s = useDashboardStore.getState();
    expect(s.diffMode).toBe(true);
    expect([...s.changedNodeIds]).toEqual(["a"]);
    expect([...s.affectedNodeIds]).toEqual(["b"]);
    expect(s.crossServiceNodeIds.size).toBe(0);
  });
});

describe("store — workspace services view", () => {
  it("opens workspace graphs in the services view", () => {
    useDashboardStore.getState().setGraph(graph(true));
    expect(useDashboardStore.getState().viewMode).toBe("services");
  });

  it("drills into a member: structural view filtered to that member's namespace", () => {
    const st = useDashboardStore.getState();
    st.setGraph(graph(true));
    st.selectNode("file:web/c.js");
    useDashboardStore.getState().drillIntoMember("brain");
    const s = useDashboardStore.getState();
    expect(s.viewMode).toBe("structural");
    expect([...s.hiddenMembers].sort()).toEqual(["motor", "web"]);
    expect(s.navigationLevel).toBe("overview");
    expect(s.selectedNodeId).toBeNull();
    expect(s.hasActiveFilters()).toBe(true);
  });

  it("toggles members and shows all again", () => {
    useDashboardStore.getState().setGraph(graph(true));
    useDashboardStore.getState().toggleMemberVisibility("motor");
    expect([...useDashboardStore.getState().hiddenMembers]).toEqual(["motor"]);
    useDashboardStore.getState().toggleMemberVisibility("motor");
    expect(useDashboardStore.getState().hiddenMembers.size).toBe(0);
    useDashboardStore.getState().drillIntoMember("web");
    useDashboardStore.getState().showAllMembers();
    expect(useDashboardStore.getState().hiddenMembers.size).toBe(0);
  });

  it("resetFilters also clears the member filter", () => {
    useDashboardStore.getState().setGraph(graph(true));
    useDashboardStore.getState().drillIntoMember("brain");
    useDashboardStore.getState().resetFilters();
    expect(useDashboardStore.getState().hiddenMembers.size).toBe(0);
    expect(useDashboardStore.getState().hasActiveFilters()).toBe(false);
  });

  it("navigating to a node of a hidden member reveals it in the structural view", () => {
    useDashboardStore.getState().setGraph(graph(true));
    useDashboardStore.getState().drillIntoMember("brain");
    useDashboardStore.getState().setViewMode("services");
    useDashboardStore.getState().navigateToNode("file:motor/b.py");
    const s = useDashboardStore.getState();
    expect(s.viewMode).toBe("structural");
    expect(s.hiddenMembers.has("motor")).toBe(false);
    expect(s.activeLayerId).toBe("layer:motor/core");
    expect(s.selectedNodeId).toBe("file:motor/b.py");
  });

  it("starting the tour leaves the services view", () => {
    useDashboardStore.getState().setGraph(graph(true));
    useDashboardStore.getState().startTour();
    expect(useDashboardStore.getState().viewMode).toBe("structural");
    expect(useDashboardStore.getState().tourActive).toBe(true);
  });

  it("a new graph clears the member filter", () => {
    useDashboardStore.getState().setGraph(graph(true));
    useDashboardStore.getState().drillIntoMember("brain");
    useDashboardStore.getState().setGraph(graph(true));
    expect(useDashboardStore.getState().hiddenMembers.size).toBe(0);
  });

  it("stores cross-service consumers of a workspace diff overlay and folds them into affected", () => {
    useDashboardStore.getState().setDiffOverlay(["file:brain/a.cs"], ["x"], ["file:web/c.js"]);
    const s = useDashboardStore.getState();
    expect([...s.crossServiceNodeIds]).toEqual(["file:web/c.js"]);
    expect(s.affectedNodeIds.has("file:web/c.js")).toBe(true);
    useDashboardStore.getState().clearDiffOverlay();
    expect(useDashboardStore.getState().crossServiceNodeIds.size).toBe(0);
  });
});

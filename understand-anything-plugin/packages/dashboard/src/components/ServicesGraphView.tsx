import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import ServiceNode from "./ServiceNode";
import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";
import { useTheme } from "../themes/index.ts";
import { mergeElkPositions, nodesToElkInput } from "../utils/layout";
import { applyElkLayout } from "../utils/elk-layout";
import { buildServiceFlow, type ServiceNodeData } from "../utils/workspace";

const nodeTypes = { service: ServiceNode };

/**
 * System view of a multi-repo workspace: one node per member, edges
 * aggregated from cross-service contracts (HTTP calls, shared message
 * channels, shared tables). Clicking a service drills into it.
 */
function ServicesGraphViewInner() {
  const graph = useDashboardStore((s) => s.graph);
  const diffMode = useDashboardStore((s) => s.diffMode);
  const changedNodeIds = useDashboardStore((s) => s.changedNodeIds);
  const crossServiceNodeIds = useDashboardStore((s) => s.crossServiceNodeIds);
  const drillIntoMember = useDashboardStore((s) => s.drillIntoMember);
  const { t } = useI18n();
  const { preset } = useTheme();

  const built = useMemo(() => {
    if (!graph) return null;
    return buildServiceFlow(graph, {
      labels: { calls: t.services.calls, messages: t.services.messages, tables: t.services.tables },
      diffMode,
      changedNodeIds,
      crossServiceNodeIds,
    });
  }, [graph, t, diffMode, changedNodeIds, crossServiceNodeIds]);

  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });

  useEffect(() => {
    if (!built) {
      setLayout({ nodes: [], edges: [] });
      return;
    }
    let cancelled = false;
    const baseNodes = built.nodes as unknown as Node[];
    const elkInput = nodesToElkInput(baseNodes, built.edges, built.dims, {
      "elk.direction": "RIGHT",
    });
    applyElkLayout(elkInput, { strict: import.meta.env.DEV })
      .then(({ positioned, issues }) => {
        if (cancelled) return;
        if (issues.length > 0) useDashboardStore.getState().appendLayoutIssues(issues);
        setLayout({ nodes: mergeElkPositions(baseNodes, positioned), edges: built.edges });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[services ELK] layout failed:", err);
        // Fall back to a simple row so the view is never empty.
        setLayout({
          nodes: baseNodes.map((n, i) => ({ ...n, position: { x: i * 420, y: 0 } })),
          edges: built.edges,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [built]);

  return (
    <div className="h-full w-full relative" data-testid="services-graph-view">
      {built && built.linkCount === 0 && built.nodes.length > 0 && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 max-w-[520px] px-4 py-2 rounded-lg bg-elevated border border-border-subtle text-xs text-text-secondary shadow-lg text-center">
          {t.services.noLinks}
        </div>
      )}
      <ReactFlow
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => drillIntoMember((node.data as ServiceNodeData).member)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.1}
        maxZoom={2}
        colorMode={preset.isDark ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-edge-dot)" />
        <Controls />
        <MiniMap
          nodeColor={(n) => (n.data as ServiceNodeData).color}
          maskColor="var(--glass-bg)"
          className="!bg-surface !border !border-border-subtle"
        />
      </ReactFlow>
    </div>
  );
}

export default function ServicesGraphView() {
  return (
    <ReactFlowProvider>
      <ServicesGraphViewInner />
    </ReactFlowProvider>
  );
}

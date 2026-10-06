import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { useI18n } from "../contexts/I18nContext";
import { fillTemplate, type ServiceNodeData } from "../utils/workspace";

export type ServiceFlowNode = Node<ServiceNodeData, "service">;

/** One workspace member in the services view; click drills into it (handled by the view). */
function ServiceNode({ data }: NodeProps<ServiceFlowNode>) {
  const { t } = useI18n();
  const ring =
    data.diffStatus === "changed"
      ? "var(--color-diff-changed)"
      : data.diffStatus === "impacted"
        ? "var(--color-diff-affected)"
        : null;

  return (
    <div
      className="h-full w-full rounded-xl border-2 bg-surface px-4 py-3 cursor-pointer transition-all hover:shadow-lg flex flex-col justify-between overflow-hidden"
      style={{
        borderColor: ring ?? data.color,
        boxShadow: ring ? `0 0 0 3px ${ring}33` : undefined,
      }}
      title={t.services.drillHint}
      data-testid={`service-node-${data.member}`}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2" style={{ background: data.color }} />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2" style={{ background: data.color }} />

      <div className="flex items-center gap-2 min-w-0">
        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: data.color }} />
        <span className="font-heading text-base text-text-primary truncate">{data.member}</span>
        {data.diffStatus && (
          <span
            className="ml-auto text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
            style={{ color: ring ?? undefined, backgroundColor: `${ring}22` }}
          >
            {data.diffStatus === "changed" ? t.services.changed : t.services.impacted}
          </span>
        )}
      </div>

      <div className="text-[11px] text-text-secondary">
        {data.fileCount} {t.services.files} · {data.nodeCount} {t.services.nodes}
      </div>
      <div className="text-[10px] text-text-muted">
        {fillTemplate(t.services.inOut, { in: data.incoming, out: data.outgoing })}
      </div>
    </div>
  );
}

export default memo(ServiceNode);

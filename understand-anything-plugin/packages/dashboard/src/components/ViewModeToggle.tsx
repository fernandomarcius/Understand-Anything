import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";
import { getWorkspaceMemberNames } from "@understand-anything/core/workspace";
import { availableViewModes, type StructuralViewMode } from "../utils/workspace";

/** View modes the header/drawer toggle offers for the loaded graph (empty → no toggle). */
export function useAvailableViewModes(): StructuralViewMode[] {
  const graph = useDashboardStore((s) => s.graph);
  const isKnowledgeGraph = useDashboardStore((s) => s.isKnowledgeGraph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);
  return availableViewModes({
    hasGraph: graph !== null,
    isKnowledgeGraph,
    hasDomainGraph: domainGraph !== null,
    isWorkspace: getWorkspaceMemberNames(graph).length > 0,
  });
}

/**
 * Services | Domain | Structural switch. For non-workspace graphs this renders
 * exactly the former Domain | Structural toggle.
 */
export default function ViewModeToggle({
  modes,
  variant,
}: {
  modes: StructuralViewMode[];
  variant: "header" | "drawer";
}) {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const { t } = useI18n();

  if (modes.length === 0) return null;

  const label = (mode: StructuralViewMode) =>
    mode === "services" ? t.services.view : mode === "domain" ? t.drawer.domain : t.drawer.structural;
  const title = (mode: StructuralViewMode) => (mode === "services" ? t.services.viewTitle : label(mode));
  const padding = variant === "header" ? "py-1" : "py-1.5";

  return (
    <div className={`${variant === "header" ? "flex" : "inline-flex"} items-center bg-elevated rounded-lg p-0.5`}>
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => setViewMode(mode)}
          title={variant === "header" ? title(mode) : undefined}
          className={`px-3 ${padding} text-xs font-medium rounded-md transition-colors ${
            viewMode === mode
              ? "bg-accent/20 text-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          {label(mode)}
        </button>
      ))}
    </div>
  );
}

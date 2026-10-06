import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";
import { getWorkspaceMemberNames } from "@understand-anything/core/workspace";
import { fillTemplate, memberColor } from "../utils/workspace";

/** Workspace member filter state: back to the services view, show all members. */
function MemberFilterChip() {
  const graph = useDashboardStore((s) => s.graph);
  const hiddenMembers = useDashboardStore((s) => s.hiddenMembers);
  const showAllMembers = useDashboardStore((s) => s.showAllMembers);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const { t } = useI18n();

  if (hiddenMembers.size === 0) return null;
  const visible = getWorkspaceMemberNames(graph).filter((m) => !hiddenMembers.has(m));

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-elevated border border-border-subtle text-xs shadow-lg">
      <button
        type="button"
        onClick={() => setViewMode("services")}
        className="font-semibold uppercase tracking-wider text-gold hover:text-gold-bright transition-colors"
      >
        ← {t.services.view}
      </button>
      <span className="text-text-muted">│</span>
      <span className="flex items-center gap-1.5 text-text-secondary">
        {visible.map((m) => (
          <span key={m} className="w-2 h-2 rounded-full" style={{ backgroundColor: memberColor(m) }} />
        ))}
        {fillTemplate(t.services.showing, { names: visible.join(", ") || "—" })}
      </span>
      <button
        type="button"
        onClick={showAllMembers}
        className="text-text-muted hover:text-gold transition-colors"
      >
        {t.services.showAll} &times;
      </button>
    </div>
  );
}

export default function Breadcrumb() {
  const navigationLevel = useDashboardStore((s) => s.navigationLevel);
  const activeLayerId = useDashboardStore((s) => s.activeLayerId);
  const graph = useDashboardStore((s) => s.graph);
  const navigateToOverview = useDashboardStore((s) => s.navigateToOverview);
  const { t } = useI18n();

  const activeLayer = graph?.layers.find((l) => l.id === activeLayerId);

  return (
    <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
      {navigationLevel === "overview" && (
        <div className="px-4 py-2 rounded-full bg-elevated border border-border-subtle text-xs font-semibold tracking-wider uppercase text-text-secondary shadow-lg">
          {t.breadcrumb.projectOverview}
        </div>
      )}

      {navigationLevel === "layer-detail" && (
        <div className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-elevated border border-gold/30 text-xs font-semibold tracking-wider uppercase shadow-lg">
          <button
            onClick={navigateToOverview}
            className="text-gold hover:text-gold-bright transition-colors"
          >
            {t.breadcrumb.project}
          </button>
          <span className="text-text-muted">›</span>
          <span className="text-text-primary">
            {activeLayer?.name ?? t.layer.defaultName}
          </span>
          <span className="text-text-muted ml-1 text-[10px] normal-case tracking-normal">
            ({t.breadcrumb.escBack})
          </span>
        </div>
      )}

      <MemberFilterChip />
    </div>
  );
}

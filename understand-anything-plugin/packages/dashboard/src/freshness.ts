export type GraphFreshnessRelation = "behind" | "ahead" | "diverged";

export type GraphFreshnessUnknownReason =
  | "missing-graph-commit"
  | "git-head-unavailable"
  | "graph-commit-unavailable"
  | "git-command-timeout"
  | "freshness-request-failed";

export type GraphFreshnessResult =
  | {
      status: "fresh";
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: 0;
      changedFiles: [];
      commitsBehind: 0;
      commitsAhead: 0;
      lastAnalyzedAt?: string;
    }
  | {
      status: "dirty";
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: number;
      changedFiles: string[];
      commitsBehind: 0;
      commitsAhead: 0;
      lastAnalyzedAt?: string;
    }
  | {
      status: "stale";
      relation: GraphFreshnessRelation;
      graphCommitHash: string;
      headCommitHash: string;
      changedFileCount: number;
      changedFiles: string[];
      commitsBehind: number;
      commitsAhead: number;
      lastAnalyzedAt?: string;
    }
  | {
      status: "unknown";
      reason: GraphFreshnessUnknownReason;
      graphCommitHash?: string;
      headCommitHash?: string;
      lastAnalyzedAt?: string;
    };

export type WorkspaceMemberUnknownReason =
  | "missing-graph-commit"
  | "member-path-missing"
  | "git-head-unavailable"
  | "git-command-timeout";

/** Mirrors `WorkspaceMemberFreshness` from core `staleness.ts`. */
export type WorkspaceMemberFreshness =
  | {
      name: string;
      path: string;
      status: "fresh" | "stale";
      graphCommitHash: string;
      headCommitHash: string;
    }
  | {
      name: string;
      path: string;
      status: "unknown";
      reason: WorkspaceMemberUnknownReason;
      graphCommitHash: string;
    };

export interface WorkspaceFreshnessReport {
  name: string;
  members: WorkspaceMemberFreshness[];
}

export interface DashboardFreshnessReport {
  graphs: {
    knowledge: GraphFreshnessResult;
    domain?: GraphFreshnessResult;
  };
  /** Present only for multi-repo workspace graphs (per-member freshness). */
  workspace?: WorkspaceFreshnessReport;
}

const UNKNOWN_REASONS = new Set<GraphFreshnessUnknownReason>([
  "missing-graph-commit",
  "git-head-unavailable",
  "graph-commit-unavailable",
  "git-command-timeout",
  "freshness-request-failed",
]);

const WORKSPACE_UNKNOWN_REASONS = new Set<WorkspaceMemberUnknownReason>([
  "missing-graph-commit",
  "member-path-missing",
  "git-head-unavailable",
  "git-command-timeout",
]);

const RELATIONS = new Set<GraphFreshnessRelation>([
  "behind",
  "ahead",
  "diverged",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || typeof record[key] === "string";
}

function isOptionalHash(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || isNonEmptyString(record[key]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isChangedFileList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((file) => typeof file === "string");
}

export function isGraphFreshnessResult(
  value: unknown,
): value is GraphFreshnessResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (!isOptionalString(value, "lastAnalyzedAt")) return false;

  if (value.status === "unknown") {
    return (
      typeof value.reason === "string" &&
      UNKNOWN_REASONS.has(value.reason as GraphFreshnessUnknownReason) &&
      isOptionalHash(value, "graphCommitHash") &&
      isOptionalHash(value, "headCommitHash")
    );
  }

  if (
    !isNonEmptyString(value.graphCommitHash) ||
    !isNonEmptyString(value.headCommitHash) ||
    !isNonNegativeInteger(value.changedFileCount) ||
    !isChangedFileList(value.changedFiles) ||
    value.changedFileCount !== value.changedFiles.length ||
    !isNonNegativeInteger(value.commitsBehind) ||
    !isNonNegativeInteger(value.commitsAhead)
  ) {
    return false;
  }

  if (value.status === "fresh") {
    return (
      value.changedFileCount === 0 &&
      value.commitsBehind === 0 &&
      value.commitsAhead === 0
    );
  }

  if (value.status === "dirty") {
    return (
      value.changedFileCount > 0 &&
      value.commitsBehind === 0 &&
      value.commitsAhead === 0
    );
  }

  if (value.status === "stale") {
    return (
      value.changedFileCount > 0 &&
      typeof value.relation === "string" &&
      RELATIONS.has(value.relation as GraphFreshnessRelation)
    );
  }

  return false;
}

function isWorkspaceMemberFreshness(
  value: unknown,
): value is WorkspaceMemberFreshness {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.graphCommitHash !== "string"
  ) {
    return false;
  }
  if (value.status === "unknown") {
    return (
      typeof value.reason === "string" &&
      WORKSPACE_UNKNOWN_REASONS.has(value.reason as WorkspaceMemberUnknownReason)
    );
  }
  return (
    (value.status === "fresh" || value.status === "stale") &&
    isNonEmptyString(value.headCommitHash)
  );
}

export function isWorkspaceFreshnessReport(
  value: unknown,
): value is WorkspaceFreshnessReport {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.members) &&
    value.members.every(isWorkspaceMemberFreshness)
  );
}

export function isDashboardFreshnessReport(
  value: unknown,
): value is DashboardFreshnessReport {
  if (!isRecord(value) || !isRecord(value.graphs)) return false;
  if (!isGraphFreshnessResult(value.graphs.knowledge)) return false;
  if ("domain" in value.graphs && !isGraphFreshnessResult(value.graphs.domain)) {
    return false;
  }
  return !("workspace" in value) || isWorkspaceFreshnessReport(value.workspace);
}

export function shouldRequestFreshness(
  demoMode: boolean,
  demoFreshnessUrl?: string,
): boolean {
  return !demoMode || Boolean(demoFreshnessUrl);
}

export async function requestFreshnessReport(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DashboardFreshnessReport> {
  const response = await fetcher(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Freshness request failed");

  const payload: unknown = await response.json();
  if (!isDashboardFreshnessReport(payload)) {
    throw new Error("Freshness response was malformed");
  }
  return payload;
}

interface FreshnessRefreshOptions {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  load: (signal: AbortSignal) => Promise<DashboardFreshnessReport>;
  onResult: (report: DashboardFreshnessReport) => void;
}

function requestFailedReport(): DashboardFreshnessReport {
  return {
    graphs: {
      knowledge: {
        status: "unknown",
        reason: "freshness-request-failed",
      },
    },
  };
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

export function startFreshnessRefresh({
  target,
  load,
  onResult,
}: FreshnessRefreshOptions): () => void {
  let activeController: AbortController | null = null;
  let stopped = false;

  const refresh = () => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    void load(controller.signal)
      .then((report) => {
        if (
          !stopped &&
          activeController === controller &&
          !controller.signal.aborted
        ) {
          onResult(report);
        }
      })
      .catch((error: unknown) => {
        if (
          stopped ||
          activeController !== controller ||
          controller.signal.aborted ||
          isAbortError(error)
        ) {
          return;
        }
        onResult(requestFailedReport());
      });
  };

  const handleFocus: EventListener = () => refresh();
  target.addEventListener("focus", handleFocus);
  refresh();

  return () => {
    stopped = true;
    target.removeEventListener("focus", handleFocus);
    activeController?.abort();
  };
}

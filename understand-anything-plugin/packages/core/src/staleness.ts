import { execFile, execFileSync } from "child_process";
import { statSync } from "fs";
import { resolve as resolvePath } from "path";
import type {
  KnowledgeGraph,
  GraphNode,
  GraphEdge,
  ProjectMeta,
} from "./types.js";

export interface StalenessResult {
  stale: boolean;
  changedFiles: string[];
}

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

export interface GraphFreshnessInput {
  graphCommitHash?: string | null;
  lastAnalyzedAt?: string;
}

interface ProjectGitSnapshot {
  projectDir: string;
  repoRoot: string;
  headCommitHash: string;
  dirtyFiles: string[];
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PROJECT_PATHSPEC = [
  "--",
  ".",
  ":(exclude).understand-anything",
  ":(exclude).understand-anything/**",
  ":(exclude).ua",
  ":(exclude).ua/**",
] as const;

class GitCommandError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly timedOut: boolean,
  ) {
    super(timedOut ? "Git command timed out" : "Git command failed");
  }
}

function runGit(projectDir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: projectDir,
        encoding: null,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new GitCommandError(
              typeof error.code === "number" ? error.code : null,
              error.killed === true && error.signal !== null,
            ),
          );
          return;
        }

        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function parseScalar(output: Buffer): string {
  return output.toString("utf8").trim();
}

function parseNulDelimitedPaths(output: Buffer): string[] {
  const value = output.toString("utf8");
  if (value.length === 0) return [];

  const paths = value.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths.filter((path) => path.length > 0);
}

function uniqueSortedPaths(...pathGroups: string[][]): string[] {
  return [...new Set(pathGroups.flat())].sort();
}

function optionalAnalysisTime(
  input: GraphFreshnessInput,
): Pick<GraphFreshnessInput, "lastAnalyzedAt"> {
  return input.lastAnalyzedAt === undefined
    ? {}
    : { lastAnalyzedAt: input.lastAnalyzedAt };
}

function unknownReason(error: unknown, fallback: GraphFreshnessUnknownReason) {
  return error instanceof GitCommandError && error.timedOut
    ? "git-command-timeout"
    : fallback;
}

async function createProjectGitSnapshot(
  projectDir: string,
): Promise<ProjectGitSnapshot> {
  const repoRoot = parseScalar(
    await runGit(projectDir, ["rev-parse", "--show-toplevel"]),
  );
  const headCommitHash = parseScalar(
    await runGit(projectDir, ["rev-parse", "HEAD"]),
  );
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(projectDir, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--relative",
      ...PROJECT_PATHSPEC,
    ]),
    runGit(projectDir, [
      "diff",
      "--name-only",
      "-z",
      "--relative",
      ...PROJECT_PATHSPEC,
    ]),
    runGit(projectDir, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...PROJECT_PATHSPEC,
    ]),
  ]);

  return {
    projectDir,
    repoRoot,
    headCommitHash,
    dirtyFiles: uniqueSortedPaths(
      parseNulDelimitedPaths(staged),
      parseNulDelimitedPaths(unstaged),
      parseNulDelimitedPaths(untracked),
    ),
  };
}

async function isAncestor(
  projectDir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(projectDir, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function evaluateGraphFreshness(
  snapshot: ProjectGitSnapshot,
  input: GraphFreshnessInput,
  requestedGraphCommitHash: string,
): Promise<GraphFreshnessResult> {
  let graphCommitHash: string;
  try {
    graphCommitHash = parseScalar(
      await runGit(snapshot.projectDir, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${requestedGraphCommitHash}^{commit}`,
      ]),
    );
  } catch (error) {
    return {
      status: "unknown",
      reason: unknownReason(error, "graph-commit-unavailable"),
      graphCommitHash: requestedGraphCommitHash,
      headCommitHash: snapshot.headCommitHash,
      ...optionalAnalysisTime(input),
    };
  }

  let committedFiles: string[];
  try {
    committedFiles = parseNulDelimitedPaths(
      await runGit(snapshot.projectDir, [
        "diff",
        "--name-only",
        "-z",
        "--relative",
        graphCommitHash,
        snapshot.headCommitHash,
        ...PROJECT_PATHSPEC,
      ]),
    );
  } catch (error) {
    return {
      status: "unknown",
      reason: unknownReason(error, "graph-commit-unavailable"),
      graphCommitHash,
      headCommitHash: snapshot.headCommitHash,
      ...optionalAnalysisTime(input),
    };
  }

  if (committedFiles.length === 0) {
    if (snapshot.dirtyFiles.length > 0) {
      return {
        status: "dirty",
        graphCommitHash,
        headCommitHash: snapshot.headCommitHash,
        changedFileCount: snapshot.dirtyFiles.length,
        changedFiles: snapshot.dirtyFiles,
        commitsBehind: 0,
        commitsAhead: 0,
        ...optionalAnalysisTime(input),
      };
    }

    return {
      status: "fresh",
      graphCommitHash,
      headCommitHash: snapshot.headCommitHash,
      changedFileCount: 0,
      changedFiles: [],
      commitsBehind: 0,
      commitsAhead: 0,
      ...optionalAnalysisTime(input),
    };
  }

  try {
    const [countsOutput, graphIsAncestor, headIsAncestor] = await Promise.all([
      runGit(snapshot.projectDir, [
        "rev-list",
        "--left-right",
        "--count",
        `${graphCommitHash}...${snapshot.headCommitHash}`,
        ...PROJECT_PATHSPEC,
      ]),
      isAncestor(
        snapshot.projectDir,
        graphCommitHash,
        snapshot.headCommitHash,
      ),
      isAncestor(
        snapshot.projectDir,
        snapshot.headCommitHash,
        graphCommitHash,
      ),
    ]);
    const [commitsAhead, commitsBehind] = parseScalar(countsOutput)
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    if (
      !Number.isFinite(commitsAhead) ||
      !Number.isFinite(commitsBehind) ||
      commitsAhead < 0 ||
      commitsBehind < 0
    ) {
      throw new GitCommandError(null, false);
    }

    const relation: GraphFreshnessRelation = graphIsAncestor
      ? "behind"
      : headIsAncestor
        ? "ahead"
        : "diverged";
    const changedFiles = uniqueSortedPaths(
      committedFiles,
      snapshot.dirtyFiles,
    );

    return {
      status: "stale",
      relation,
      graphCommitHash,
      headCommitHash: snapshot.headCommitHash,
      changedFileCount: changedFiles.length,
      changedFiles,
      commitsBehind,
      commitsAhead,
      ...optionalAnalysisTime(input),
    };
  } catch (error) {
    return {
      status: "unknown",
      reason: unknownReason(error, "graph-commit-unavailable"),
      graphCommitHash,
      headCommitHash: snapshot.headCommitHash,
      ...optionalAnalysisTime(input),
    };
  }
}

function parseChangedFiles(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Get the list of files that changed between a given commit and HEAD.
 * Returns an empty array if there are no changes or if git encounters an error.
 */
export function getChangedFiles(
  projectDir: string,
  lastCommitHash: string,
): string[] {
  try {
    const output = execFileSync("git", ["diff", `${lastCommitHash}..HEAD`, "--name-only"], {
      cwd: projectDir,
      encoding: "utf-8",
    });
    return parseChangedFiles(output);
  } catch {
    return [];
  }
}

/**
 * Check whether the knowledge graph is stale relative to the current HEAD.
 */
export function isStale(
  projectDir: string,
  lastCommitHash: string,
): StalenessResult {
  const changedFiles = getChangedFiles(projectDir, lastCommitHash);
  return {
    stale: changedFiles.length > 0,
    changedFiles,
  };
}

/**
 * Describe the freshness of multiple persisted graphs against one Git snapshot.
 */
export async function getGraphFreshnessBatch<T extends string>(
  projectDir: string,
  inputs: Record<T, GraphFreshnessInput>,
): Promise<Record<T, GraphFreshnessResult>> {
  const entries = Object.entries(inputs) as [T, GraphFreshnessInput][];
  const results = {} as Record<T, GraphFreshnessResult>;
  const comparableEntries: [T, GraphFreshnessInput, string][] = [];

  for (const [key, input] of entries) {
    const graphCommitHash = input.graphCommitHash?.trim();
    if (!graphCommitHash) {
      results[key] = {
        status: "unknown",
        reason: "missing-graph-commit",
        ...optionalAnalysisTime(input),
      };
      continue;
    }
    comparableEntries.push([key, input, graphCommitHash]);
  }

  if (comparableEntries.length === 0) return results;

  let snapshot: ProjectGitSnapshot;
  try {
    snapshot = await createProjectGitSnapshot(projectDir);
  } catch (error) {
    const reason = unknownReason(error, "git-head-unavailable");
    for (const [key, input, graphCommitHash] of comparableEntries) {
      results[key] = {
        status: "unknown",
        reason,
        graphCommitHash,
        ...optionalAnalysisTime(input),
      };
    }
    return results;
  }

  await Promise.all(
    comparableEntries.map(async ([key, input, graphCommitHash]) => {
      results[key] = await evaluateGraphFreshness(
        snapshot,
        input,
        graphCommitHash,
      );
    }),
  );

  return results;
}

/**
 * Describe whether a persisted graph can still be trusted for the project.
 *
 * Unknown is intentionally distinct from fresh: if Git metadata cannot be
 * read, callers should warn softly rather than imply the graph is current.
 */
export async function getGraphFreshness(
  projectDir: string,
  input: GraphFreshnessInput,
): Promise<GraphFreshnessResult> {
  const results = await getGraphFreshnessBatch(projectDir, { graph: input });
  return results.graph;
}

/*
 * ── Workspace freshness contract (multi-repo workspace graphs) ──────────────
 *
 * Server side (dashboard vite.config.ts and viewer bin/viewer.mjs):
 *   const workspace = await getWorkspaceFreshness(dirContainingUaDir, graph);
 *   // graph = parsed knowledge-graph.json (only `project.workspace` is read)
 *   // workspaceRoot = the directory that contains `.ua/` (member paths are
 *   // relative to it, exactly as written in ua-workspace.json).
 *   if (workspace) payload.workspace = workspace;   // GET /staleness.json
 *
 * `/staleness.json` payload becomes:
 *   {
 *     graphs: { knowledge: GraphFreshnessResult; domain?: GraphFreshnessResult },
 *     workspace?: WorkspaceFreshnessReport          // only for workspace graphs
 *   }
 * `graphs.knowledge` stays mandatory (keep computing it as today; for a
 * workspace root it is usually "unknown"). When `workspace` is present the
 * dashboard banner ignores `graphs` and reports per member instead, listing
 * the names of stale members. Members are returned in manifest order:
 *   { name, path, status: "fresh",   graphCommitHash, headCommitHash }
 *   { name, path, status: "stale",   graphCommitHash, headCommitHash }
 *   { name, path, status: "unknown", graphCommitHash, reason }
 * reason ∈ "missing-graph-commit" | "member-path-missing"
 *        | "git-head-unavailable" (not a Git repo / no HEAD) | "git-command-timeout".
 * A member that is not a Git repository is "unknown", never "stale".
 * Returns null when the graph has no `project.workspace`.
 */

export type WorkspaceMemberUnknownReason =
  | "missing-graph-commit"
  | "member-path-missing"
  | "git-head-unavailable"
  | "git-command-timeout";

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

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Per-member freshness of a merged workspace graph: `git rev-parse HEAD` in
 * `<workspaceRoot>/<member.path>` compared with the member's recorded
 * `gitCommitHash`. See the contract block above.
 */
export async function getWorkspaceFreshness(
  workspaceRoot: string,
  graph: { project: Pick<ProjectMeta, "workspace"> },
): Promise<WorkspaceFreshnessReport | null> {
  const workspace = graph.project.workspace;
  if (!workspace) return null;

  const members = await Promise.all(
    workspace.members.map(async (member): Promise<WorkspaceMemberFreshness> => {
      const base = { name: member.name, path: member.path };
      const graphCommitHash = member.gitCommitHash.trim();
      const unknown = (reason: WorkspaceMemberUnknownReason) => ({
        ...base,
        status: "unknown" as const,
        reason,
        graphCommitHash: member.gitCommitHash,
      });

      if (!graphCommitHash) return unknown("missing-graph-commit");
      const memberDir = resolvePath(workspaceRoot, member.path);
      if (!isDirectory(memberDir)) return unknown("member-path-missing");

      let headCommitHash: string;
      try {
        headCommitHash = parseScalar(
          await runGit(memberDir, ["rev-parse", "HEAD"]),
        );
      } catch (error) {
        return unknown(
          error instanceof GitCommandError && error.timedOut
            ? "git-command-timeout"
            : "git-head-unavailable",
        );
      }

      return {
        ...base,
        status: headCommitHash === graphCommitHash ? "fresh" : "stale",
        graphCommitHash,
        headCommitHash,
      };
    }),
  );

  return { name: workspace.name, members };
}

/**
 * Merge new analysis results into an existing knowledge graph.
 *
 * 1. Remove old nodes belonging to changed files (matched by filePath).
 * 2. Remove old edges where the SOURCE or TARGET node belongs to a changed file.
 * 3. Add new nodes and edges.
 * 4. Update project.gitCommitHash and project.analyzedAt.
 * 5. Return the merged graph.
 */
export function mergeGraphUpdate(
  existingGraph: KnowledgeGraph,
  changedFilePaths: string[],
  newNodes: GraphNode[],
  newEdges: GraphEdge[],
  newCommitHash: string,
): KnowledgeGraph {
  const changedSet = new Set(changedFilePaths);

  // Collect IDs of nodes that belong to changed files (will be removed)
  const removedNodeIds = new Set(
    existingGraph.nodes
      .filter((node) => node.filePath !== undefined && changedSet.has(node.filePath))
      .map((node) => node.id),
  );

  // Keep nodes that don't belong to changed files
  const retainedNodes = existingGraph.nodes.filter(
    (node) => !removedNodeIds.has(node.id),
  );

  // Keep edges whose source or target node is not in the removed set
  const retainedEdges = existingGraph.edges.filter(
    (edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target),
  );

  return {
    ...existingGraph,
    project: {
      ...existingGraph.project,
      gitCommitHash: newCommitHash,
      analyzedAt: new Date().toISOString(),
    },
    nodes: [...retainedNodes, ...newNodes],
    edges: [...retainedEdges, ...newEdges],
  };
}

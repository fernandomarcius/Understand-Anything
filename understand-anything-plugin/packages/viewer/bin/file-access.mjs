/**
 * Multi-repo workspace file access (docs/multi-repo-workspace.md).
 *
 * Same logic, same names as the helpers in packages/dashboard/vite.config.ts
 * (kept in sync by design). Side-effect free so it can be unit-tested without
 * starting the viewer.
 */
import fs from "node:fs";
import path from "node:path";

const WORKSPACE_MEMBER_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `project.workspace.members` of a parsed graph, or null when it is not a
 * workspace graph. Malformed entries are dropped, so a request for them fails
 * as an undeclared member.
 *
 * @param {unknown} graph
 * @returns {{ name: string, path: string }[] | null}
 */
export function workspaceMembersFromGraph(graph) {
  const members = graph?.project?.workspace?.members;
  if (!Array.isArray(members)) return null;
  const valid = [];
  for (const member of members) {
    const { name, path: memberPath } = member ?? {};
    if (
      typeof name === "string" &&
      WORKSPACE_MEMBER_NAME.test(name) &&
      typeof memberPath === "string" &&
      memberPath.length > 0 &&
      !memberPath.includes("\0")
    ) {
      valid.push({ name, path: memberPath });
    }
  }
  return valid;
}

/**
 * The `project.workspace` block of a parsed graph, sanitized for core
 * `getWorkspaceFreshness` (malformed members dropped, a non-string
 * `gitCommitHash` becomes "" → reported as `missing-graph-commit`), or null
 * when it is not a workspace graph. Mirrors the dashboard's helper.
 *
 * @param {unknown} graph
 */
export function workspaceFreshnessGraph(graph) {
  const workspace = graph?.project?.workspace;
  if (!workspace || !Array.isArray(workspace.members)) return null;
  const members = [];
  for (const member of workspace.members) {
    const { name, path: memberPath, gitCommitHash } = member ?? {};
    if (
      typeof name !== "string" ||
      !WORKSPACE_MEMBER_NAME.test(name) ||
      typeof memberPath !== "string" ||
      memberPath.length === 0 ||
      memberPath.includes("\0")
    ) {
      continue;
    }
    members.push({
      name,
      path: memberPath,
      gitCommitHash: typeof gitCommitHash === "string" ? gitCommitHash : "",
      analyzedAt: "",
      nodes: 0,
      edges: 0,
    });
  }
  return {
    project: {
      workspace: {
        name: typeof workspace.name === "string" ? workspace.name : "",
        members,
      },
    },
  };
}

function isStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve a workspace request `M/rel/path` (`workspaceRoot` = directory that
 * contains `.ua/`). Rejections are 403, except a missing file (404). The
 * returned `absoluteFile` is the real path, already confined to the member.
 *
 * @param {string} requestedPath
 * @param {string} workspaceRoot
 * @param {readonly { name: string, path: string }[]} members
 * @param {ReadonlySet<string>} allowedPaths
 * @returns {{ ok: true, absoluteFile: string, safeRelativePath: string }
 *   | { ok: false, statusCode: number, error: string }}
 */
export function resolveWorkspaceFilePath(requestedPath, workspaceRoot, members, allowedPaths) {
  const forbidden = (error) => ({ ok: false, statusCode: 403, error });
  const outside = "Path must stay inside a workspace member";
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    requestedPath.includes("\\") ||
    path.isAbsolute(requestedPath)
  ) {
    return forbidden(outside);
  }
  const segments = requestedPath.split("/");
  if (segments.length < 2 || segments.some((s) => s === "" || s === "." || s === "..")) {
    return forbidden(outside);
  }
  const member = members.find((m) => m.name === segments[0]);
  if (!member) return forbidden("Unknown workspace member");
  if (!allowedPaths.has(requestedPath)) return forbidden("File is not in the knowledge graph");

  const memberRoot = path.resolve(workspaceRoot, member.path);
  const absoluteFile = path.resolve(memberRoot, ...segments.slice(1));
  if (!isStrictlyInside(memberRoot, absoluteFile)) return forbidden(outside);

  let realFile;
  try {
    const realRoot = fs.realpathSync(memberRoot);
    realFile = fs.realpathSync(absoluteFile);
    if (!isStrictlyInside(realRoot, realFile)) return forbidden(outside);
  } catch {
    return { ok: false, statusCode: 404, error: "File not found" };
  }
  return { ok: true, absoluteFile: realFile, safeRelativePath: requestedPath };
}

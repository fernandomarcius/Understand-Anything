import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceFreshness } from "../staleness.js";
import type { ProjectMeta, WorkspaceMemberMeta } from "../types.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ua-ws-freshness-"));
  temporaryDirectories.push(directory);
  return directory;
}

function initRepository(repoDir: string): string {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init");
  git(repoDir, "config", "user.email", "freshness-tests@example.com");
  git(repoDir, "config", "user.name", "Freshness Tests");
  writeFileSync(join(repoDir, "index.ts"), "export const value = 1;\n", "utf8");
  git(repoDir, "add", "--all");
  git(repoDir, "commit", "-m", "baseline");
  return git(repoDir, "rev-parse", "HEAD");
}

function member(
  name: string,
  path: string,
  gitCommitHash: string,
): WorkspaceMemberMeta {
  return {
    name,
    path,
    gitCommitHash,
    analyzedAt: "2026-10-01T00:00:00.000Z",
    nodes: 1,
    edges: 0,
  };
}

function workspaceProject(members: WorkspaceMemberMeta[]): { project: ProjectMeta } {
  return {
    project: {
      name: "cloudbi",
      languages: [],
      frameworks: [],
      description: "Workspace",
      analyzedAt: "2026-10-01T00:00:00.000Z",
      gitCommitHash: "ws:" + "c".repeat(40),
      workspace: { name: "cloudbi", members },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("getWorkspaceFreshness with real Git repositories", { timeout: 15_000 }, () => {
  it("returns null for a graph without project.workspace", async () => {
    const root = createTemporaryDirectory();
    const graph = workspaceProject([]);
    delete graph.project.workspace;
    await expect(getWorkspaceFreshness(root, graph)).resolves.toBeNull();
  });

  it("reports fresh, stale and unknown members in manifest order", async () => {
    const parent = createTemporaryDirectory();
    const root = join(parent, "ws");
    mkdirSync(root);

    const freshHead = initRepository(join(parent, "fresh-svc"));

    const staleBaseline = initRepository(join(parent, "stale-svc"));
    writeFileSync(join(parent, "stale-svc", "index.ts"), "export const value = 2;\n", "utf8");
    git(join(parent, "stale-svc"), "commit", "-am", "change");
    const staleHead = git(join(parent, "stale-svc"), "rev-parse", "HEAD");

    mkdirSync(join(parent, "plain-dir"));

    const report = await getWorkspaceFreshness(
      root,
      workspaceProject([
        member("fresh", "../fresh-svc", freshHead),
        member("stale", "../stale-svc", staleBaseline),
        member("plain", "../plain-dir", "d".repeat(40)),
        member("gone", "../does-not-exist", "e".repeat(40)),
        member("nohash", "../fresh-svc", ""),
      ]),
    );

    expect(report).toEqual({
      name: "cloudbi",
      members: [
        {
          name: "fresh",
          path: "../fresh-svc",
          status: "fresh",
          graphCommitHash: freshHead,
          headCommitHash: freshHead,
        },
        {
          name: "stale",
          path: "../stale-svc",
          status: "stale",
          graphCommitHash: staleBaseline,
          headCommitHash: staleHead,
        },
        {
          name: "plain",
          path: "../plain-dir",
          status: "unknown",
          reason: "git-head-unavailable",
          graphCommitHash: "d".repeat(40),
        },
        {
          name: "gone",
          path: "../does-not-exist",
          status: "unknown",
          reason: "member-path-missing",
          graphCommitHash: "e".repeat(40),
        },
        {
          name: "nohash",
          path: "../fresh-svc",
          status: "unknown",
          reason: "missing-graph-commit",
          graphCommitHash: "",
        },
      ],
    });
  });

  it("never reports a non-git member as stale, even when the hash differs", async () => {
    const root = createTemporaryDirectory();
    mkdirSync(join(root, "svc"));
    const report = await getWorkspaceFreshness(
      root,
      workspaceProject([member("svc", "svc", "f".repeat(40))]),
    );
    expect(report?.members[0].status).toBe("unknown");
  });
});

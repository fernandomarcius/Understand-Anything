import { describe, expect, it } from "vitest";
import type {
  DashboardFreshnessReport,
  GraphFreshnessResult,
} from "../../freshness";
import { buildFreshnessBanner } from "../StalenessBanner";
import { locales } from "../../locales";

const fresh: GraphFreshnessResult = {
  status: "fresh",
  graphCommitHash: "a".repeat(40),
  headCommitHash: "a".repeat(40),
  changedFileCount: 0,
  changedFiles: [],
  commitsBehind: 0,
  commitsAhead: 0,
};

function report(
  knowledge: GraphFreshnessResult,
  domain?: GraphFreshnessResult,
): DashboardFreshnessReport {
  return { graphs: domain ? { knowledge, domain } : { knowledge } };
}

describe("buildFreshnessBanner", () => {
  it("returns no banner for fresh or missing freshness data", () => {
    expect(buildFreshnessBanner(null)).toBeNull();
    expect(buildFreshnessBanner(report(fresh))).toBeNull();
  });

  it("uses singular grammar for a graph one project commit behind", () => {
    const banner = buildFreshnessBanner(
      report({
        status: "stale",
        relation: "behind",
        graphCommitHash: "a".repeat(40),
        headCommitHash: "b".repeat(40),
        changedFileCount: 1,
        changedFiles: ["src/auth.ts"],
        commitsBehind: 1,
        commitsAhead: 0,
      }),
    );

    expect(banner).toEqual({
      title: "Knowledge graph may be stale",
      summary:
        "The knowledge graph is 1 project commit behind HEAD; 1 file has changed since analysis.",
      action:
        "Run /understand to refresh it before relying on impact or onboarding answers.",
      changedFiles: ["src/auth.ts"],
    });
  });

  it("explains an ahead domain graph with the correct refresh command", () => {
    const banner = buildFreshnessBanner(
      report(fresh, {
        status: "stale",
        relation: "ahead",
        graphCommitHash: "b".repeat(40),
        headCommitHash: "a".repeat(40),
        changedFileCount: 2,
        changedFiles: ["domain/a.ts", "domain/b.ts"],
        commitsBehind: 0,
        commitsAhead: 1,
      }),
    );

    expect(banner).toMatchObject({
      title: "Domain graph may be stale",
      summary:
        "The domain graph comes from a newer project history than HEAD; 2 files have changed since analysis.",
      action:
        "Run /understand-domain to refresh it before relying on impact or onboarding answers.",
    });
  });

  it("explains divergent histories", () => {
    const banner = buildFreshnessBanner(
      report({
        status: "stale",
        relation: "diverged",
        graphCommitHash: "a".repeat(40),
        headCommitHash: "b".repeat(40),
        changedFileCount: 2,
        changedFiles: ["src/a.ts", "src/b.ts"],
        commitsBehind: 1,
        commitsAhead: 1,
      }),
    );

    expect(banner?.summary).toBe(
      "The knowledge graph and HEAD come from different project histories; 2 files have changed since analysis.",
    );
  });

  it("prioritizes stale over dirty and unknown graph results", () => {
    const banner = buildFreshnessBanner(
      report(
        {
          status: "dirty",
          graphCommitHash: "a".repeat(40),
          headCommitHash: "a".repeat(40),
          changedFileCount: 1,
          changedFiles: ["src/dirty.ts"],
          commitsBehind: 0,
          commitsAhead: 0,
        },
        {
          status: "stale",
          relation: "behind",
          graphCommitHash: "a".repeat(40),
          headCommitHash: "b".repeat(40),
          changedFileCount: 1,
          changedFiles: ["domain/stale.ts"],
          commitsBehind: 1,
          commitsAhead: 0,
        },
      ),
    );

    expect(banner?.title).toBe("Domain graph may be stale");
    expect(banner?.changedFiles).toEqual(["domain/stale.ts"]);
  });

  it("names both graphs when they share the highest dirty risk", () => {
    const dirtyKnowledge: GraphFreshnessResult = {
      status: "dirty",
      graphCommitHash: "a".repeat(40),
      headCommitHash: "a".repeat(40),
      changedFileCount: 1,
      changedFiles: ["src/shared.ts"],
      commitsBehind: 0,
      commitsAhead: 0,
    };
    const banner = buildFreshnessBanner(
      report(dirtyKnowledge, {
        ...dirtyKnowledge,
        changedFileCount: 2,
        changedFiles: ["src/shared.ts", "domain/model.ts"],
      }),
    );

    expect(banner?.title).toBe(
      "Knowledge and domain graphs have working-tree changes",
    );
    expect(banner?.changedFiles).toEqual([
      "domain/model.ts",
      "src/shared.ts",
    ]);
  });

  it("makes endpoint failures visible instead of treating them as fresh", () => {
    const banner = buildFreshnessBanner({
      graphs: {
        knowledge: {
          status: "unknown",
          reason: "freshness-request-failed",
        },
      },
    });

    expect(banner).toMatchObject({
      title: "Knowledge graph freshness could not be verified",
      summary: "The dashboard could not refresh graph freshness data.",
      changedFiles: [],
    });
  });
});

describe("buildFreshnessBanner for workspace graphs", () => {
  const unknownKnowledge: GraphFreshnessResult = {
    status: "unknown",
    reason: "git-head-unavailable",
  };

  function workspaceReport(
    members: NonNullable<DashboardFreshnessReport["workspace"]>["members"],
  ): DashboardFreshnessReport {
    return { graphs: { knowledge: unknownKnowledge }, workspace: { name: "cloudbi", members } };
  }

  const freshMember = (name: string) => ({
    name,
    path: `../${name}`,
    status: "fresh" as const,
    graphCommitHash: "a".repeat(40),
    headCommitHash: "a".repeat(40),
  });
  const staleMember = (name: string) => ({
    name,
    path: `../${name}`,
    status: "stale" as const,
    graphCommitHash: "a".repeat(40),
    headCommitHash: "b".repeat(40),
  });
  const unknownMember = (name: string) => ({
    name,
    path: `../${name}`,
    status: "unknown" as const,
    reason: "git-head-unavailable" as const,
    graphCommitHash: "c".repeat(40),
  });

  it("shows no banner when every member is fresh, ignoring the root-level graph result", () => {
    expect(
      buildFreshnessBanner(workspaceReport([freshMember("brain"), freshMember("motor")])),
    ).toBeNull();
  });

  it("lists the stale member names", () => {
    const banner = buildFreshnessBanner(
      workspaceReport([freshMember("brain"), staleMember("motor"), staleMember("api")]),
    );
    expect(banner).toEqual({
      title: "Workspace graph may be stale",
      summary: "2 of 3 members changed since analysis: motor, api.",
      action:
        "Run /understand --workspace to refresh them before relying on impact or onboarding answers.",
      changedFiles: [],
    });
  });

  it("mentions unverifiable members alongside stale ones without calling them stale", () => {
    const banner = buildFreshnessBanner(
      workspaceReport([staleMember("motor"), unknownMember("docs")]),
    );
    expect(banner?.title).toBe("Workspace graph may be stale");
    expect(banner?.summary).toBe(
      "1 of 2 members changed since analysis: motor. Could not verify 1 of 2 members (not a Git repository or Git unavailable): docs.",
    );
  });

  it("reports unknown-only workspaces softly", () => {
    const banner = buildFreshnessBanner(
      workspaceReport([freshMember("brain"), unknownMember("docs")]),
    );
    expect(banner).toEqual({
      title: "Workspace freshness could not be fully verified",
      summary:
        "Could not verify 1 of 2 members (not a Git repository or Git unavailable): docs.",
      action: "Members outside Git cannot be checked; they are never reported as stale.",
      changedFiles: [],
    });
  });

  it("renders workspace strings from the active locale", () => {
    const banner = buildFreshnessBanner(
      workspaceReport([staleMember("motor"), freshMember("brain")]),
      locales.ja.stalenessBanner,
    );
    expect(banner?.title).toBe(locales.ja.stalenessBanner.workspaceStaleTitle);
    expect(banner?.summary).toContain("motor");
    expect(banner?.summary).not.toContain("{names}");
  });
});

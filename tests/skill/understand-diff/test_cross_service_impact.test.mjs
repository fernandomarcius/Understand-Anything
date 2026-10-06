// /understand-diff workspace mode: skills/understand-diff/cross-service-impact.mjs
// maps per-member changed paths onto the merged workspace graph and reports the
// cross-service impact (endpoints → consumers in other services, channels, tables).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "understand-anything-plugin", "skills", "understand-diff", "cross-service-impact.mjs");
const EP = "endpoint:brain/src/Api.cs:GET /api/ops";

function fileNode(filePath) {
  return { id: `file:${filePath}`, type: "file", name: filePath.split("/").pop(), filePath, summary: "", tags: [], complexity: "simple" };
}

function workspaceGraph() {
  return {
    version: "1.0.0",
    project: {
      name: "ws", languages: [], frameworks: [], description: "", analyzedAt: "x", gitCommitHash: "ws:0",
      workspace: {
        name: "ws",
        members: [
          { name: "brain", path: "../brain", gitCommitHash: "a", analyzedAt: "x", nodes: 2, edges: 1 },
          { name: "web", path: "../web", gitCommitHash: "b", analyzedAt: "x", nodes: 1, edges: 0 },
        ],
      },
    },
    nodes: [
      fileNode("brain/src/Api.cs"),
      { id: EP, type: "endpoint", name: "GET /api/ops", filePath: "brain/src/Api.cs", summary: "", tags: ["contract"], complexity: "simple" },
      fileNode("web/src/client.js"),
    ],
    edges: [
      { source: "file:brain/src/Api.cs", target: EP, type: "routes", direction: "forward", weight: 1 },
      {
        source: "file:web/src/client.js", target: EP, type: "calls", direction: "forward", weight: 0.9,
        crossService: true, confidence: 0.9, evidence: { consumer: "web/src/client.js:17", via: "axios" },
      },
    ],
    layers: [],
    tour: [],
  };
}

let root;
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ua-xsvc-"));
  mkdirSync(join(root, ".ua"), { recursive: true });
  writeFileSync(join(root, ".ua", "knowledge-graph.json"), JSON.stringify(workspaceGraph()));
  writeFileSync(join(root, "changes.json"), JSON.stringify({ brain: ["src/Api.cs"] }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cross-service-impact.mjs", () => {
  it("prints the cross-service impact section for member-relative changes", () => {
    const res = run([root, "--changes", join(root, "changes.json")]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("## Cross-Service Impact");
    expect(res.stdout).toContain("**GET /api/ops** (brain)");
    expect(res.stdout).toContain("`web/src/client.js:17` (web, via axios, confidence 0.9)");
  });

  it("emits JSON and writes a workspace diff overlay with cross-service consumers", () => {
    const res = run([root, "--changes", join(root, "changes.json"), "--json", "--overlay", "--base", "main"]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.changedFiles).toEqual(["brain/src/Api.cs"]);
    expect(out.impact.consumerNodeIds).toEqual(["file:web/src/client.js"]);
    const overlay = JSON.parse(readFileSync(join(root, ".ua", "diff-overlay.json"), "utf8"));
    expect(overlay).toMatchObject({
      version: "1.0.0",
      baseBranch: "main",
      workspace: true,
      changedNodeIds: [EP, "file:brain/src/Api.cs"],
      crossServiceNodeIds: ["file:web/src/client.js"],
    });
    expect(overlay.affectedNodeIds).toContain("file:web/src/client.js");
  });

  it("rejects unknown members and non-workspace graphs", () => {
    writeFileSync(join(root, "bad.json"), JSON.stringify({ ghost: ["a.ts"] }));
    const bad = run([root, "--changes", join(root, "bad.json")]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("ghost");

    const g = workspaceGraph();
    delete g.project.workspace;
    writeFileSync(join(root, ".ua", "knowledge-graph.json"), JSON.stringify(g));
    const plain = run([root, "--changes", join(root, "changes.json")]);
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain("not a workspace graph");
    expect(existsSync(join(root, ".ua", "diff-overlay.json"))).toBe(false);
  });

  it("honours the legacy .understand-anything data directory", () => {
    mkdirSync(join(root, ".understand-anything"));
    writeFileSync(join(root, ".understand-anything", "knowledge-graph.json"), JSON.stringify(workspaceGraph()));
    rmSync(join(root, ".ua"), { recursive: true });
    const res = run([root, "--changes", join(root, "changes.json"), "--overlay"]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(root, ".understand-anything", "diff-overlay.json"))).toBe(true);
  });
});

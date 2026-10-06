// Workspace (multi-repo) support in the standalone viewer's /file-content.json.
// Mirrors packages/dashboard/src/__tests__/vite-file-content.test.ts: the pure
// resolution helper is unit-tested directly; the real server is exercised
// end-to-end when the embedded dashboard build (dist/) exists.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveWorkspaceFilePath,
  workspaceFreshnessGraph,
  workspaceMembersFromGraph,
} from "../../../understand-anything-plugin/packages/viewer/bin/file-access.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VIEWER_DIR = join(REPO_ROOT, "understand-anything-plugin", "packages", "viewer");
const VIEWER_BIN = join(VIEWER_DIR, "bin", "viewer.mjs");
const VIEWER_DIST = join(VIEWER_DIR, "dist");

const MEMBERS = [
  { name: "brain", path: "../brain", gitCommitHash: "a", analyzedAt: "x", nodes: 1, edges: 0 },
  { name: "motor", path: "../motor", gitCommitHash: "b", analyzedAt: "x", nodes: 2, edges: 0 },
];
const ALLOWED = ["brain/src/a.ts", "motor/lib/b.py", "motor/link.txt", "ghost/src/a.ts"];

function write(root, relativePath, contents) {
  const filePath = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function fileNode(filePath) {
  return {
    id: `file:${filePath}`, type: "file", name: basename(filePath), filePath,
    summary: "s", tags: [], complexity: "simple",
  };
}

function graph(nodes, workspace) {
  return {
    version: "1.0.0",
    project: {
      name: "fixture", languages: ["ts"], frameworks: [], description: "d",
      analyzedAt: "2026-07-17T00:00:00.000Z", gitCommitHash: "ws:0",
      ...(workspace ? { workspace } : {}),
    },
    nodes: nodes.map(fileNode),
    edges: [],
    layers: [],
    tour: [],
  };
}

/** <tmp>/ws (workspace root) + members <tmp>/brain, <tmp>/motor + <tmp>/outside. */
function setupWorkspace() {
  const tmp = mkdtempSync(join(tmpdir(), "ua-viewer-ws-"));
  write(tmp, "brain/src/a.ts", "export const brain = 1;\n");
  write(tmp, "brain/notlisted.ts", "export const hidden = true;\n");
  write(tmp, "motor/lib/b.py", "motor = 2\n");
  const secret = write(tmp, "outside/secret.txt", "TOP SECRET\n");
  symlinkSync(secret, join(tmp, "motor", "link.txt"));
  write(tmp, "ws/.ua/knowledge-graph.json", JSON.stringify(graph(ALLOWED, { name: "ws", members: MEMBERS })));
  return tmp;
}

/** Plain project whose top-level folder happens to look like a member name. */
function setupPlainProject() {
  const root = mkdtempSync(join(tmpdir(), "ua-viewer-plain-"));
  write(root, "brain/src/a.ts", "export const plain = 1;\n");
  write(root, "secret.txt", "not in graph\n");
  write(root, ".ua/knowledge-graph.json", JSON.stringify(graph(["brain/src/a.ts"])));
  return root;
}

describe("viewer resolveWorkspaceFilePath", () => {
  let tmp;
  beforeAll(() => { tmp = setupWorkspace(); });
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it("resolves a member file to its real path", () => {
    expect(
      resolveWorkspaceFilePath("motor/lib/b.py", join(tmp, "ws"), MEMBERS, new Set(ALLOWED)),
    ).toEqual({
      ok: true,
      absoluteFile: realpathSync(join(tmp, "motor", "lib", "b.py")),
      safeRelativePath: "motor/lib/b.py",
    });
  });

  it.each([
    "brain/../../etc/passwd",
    "brain/../motor/lib/b.py",
    "brain/./src/a.ts",
    "brain//src/a.ts",
    "brain\\..\\motor\\lib\\b.py",
    "ghost/src/a.ts",
    "brain/notlisted.ts",
    "motor/link.txt",
    "brain",
    "/etc/passwd",
  ])("returns 403 for %j", (requested) => {
    expect(
      resolveWorkspaceFilePath(requested, join(tmp, "ws"), MEMBERS, new Set(ALLOWED)),
    ).toMatchObject({ ok: false, statusCode: 403 });
  });

  it("parses workspace members from the graph", () => {
    expect(workspaceMembersFromGraph({ project: { name: "p" } })).toBeNull();
    expect(
      workspaceMembersFromGraph({
        project: { workspace: { members: [{ name: "brain", path: "../brain" }, { name: "Bad", path: "x" }] } },
      }),
    ).toEqual([{ name: "brain", path: "../brain" }]);
  });
});

describe("viewer workspaceFreshnessGraph", () => {
  it("returns null for a non-workspace graph", () => {
    expect(workspaceFreshnessGraph({ project: { name: "p" } })).toBeNull();
    expect(workspaceFreshnessGraph(null)).toBeNull();
  });

  it("keeps valid members and blanks a non-string commit hash", () => {
    expect(
      workspaceFreshnessGraph({
        project: {
          workspace: {
            name: "ws",
            members: [
              { name: "brain", path: "../brain", gitCommitHash: "abc" },
              { name: "motor", path: "../motor", gitCommitHash: 42 },
              { name: "Bad", path: "x", gitCommitHash: "def" },
            ],
          },
        },
      }),
    ).toEqual({
      project: {
        workspace: {
          name: "ws",
          members: [
            { name: "brain", path: "../brain", gitCommitHash: "abc", analyzedAt: "", nodes: 0, edges: 0 },
            { name: "motor", path: "../motor", gitCommitHash: "", analyzedAt: "", nodes: 0, edges: 0 },
          ],
        },
      },
    });
  });
});

function startViewer(projectRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.execPath,
      [VIEWER_BIN, projectRoot, "--no-open", "--port", "0"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`viewer did not start.\n${out}`));
    }, 10_000);
    const onData = (chunk) => {
      out += String(chunk);
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ proc, port: Number(m[1]), token: m[2] });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`viewer exited with ${code}.\n${out}`));
    });
  });
}

describe.skipIf(!existsSync(VIEWER_DIST))("understand-anything-viewer workspace file-content", () => {
  let tmp;
  let plainRoot;
  let viewer;
  let plainViewer;

  beforeAll(async () => {
    tmp = setupWorkspace();
    plainRoot = setupPlainProject();
    viewer = await startViewer(join(tmp, "ws"));
    plainViewer = await startViewer(plainRoot);
  }, 20_000);

  afterAll(() => {
    viewer?.proc.kill();
    plainViewer?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (plainRoot) rmSync(plainRoot, { recursive: true, force: true });
  });

  const fetchFile = (v, p) =>
    fetch(`http://127.0.0.1:${v.port}/file-content.json?token=${v.token}&path=${encodeURIComponent(p)}`);

  it("serves a file from each member", async () => {
    const brain = await fetchFile(viewer, "brain/src/a.ts");
    expect(brain.status).toBe(200);
    expect(await brain.json()).toMatchObject({
      path: "brain/src/a.ts", language: "typescript", content: "export const brain = 1;\n",
    });

    const motor = await fetchFile(viewer, "motor/lib/b.py");
    expect(motor.status).toBe(200);
    expect(await motor.json()).toMatchObject({
      path: "motor/lib/b.py", language: "python", content: "motor = 2\n",
    });
  });

  it.each([
    "brain/../../etc/passwd",
    "brain/../motor/lib/b.py",
    "ghost/src/a.ts",
    "brain/notlisted.ts",
    "motor/link.txt",
    "/etc/passwd",
  ])("rejects %j with 403", async (requested) => {
    const res = await fetchFile(viewer, requested);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("keeps non-workspace responses unchanged", async () => {
    const ok = await fetchFile(plainViewer, "brain/src/a.ts");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      path: "brain/src/a.ts", language: "typescript", content: "export const plain = 1;\n",
      sizeBytes: 24, lineCount: 2,
    });
    expect((await fetchFile(plainViewer, "secret.txt")).status).toBe(404);
    const traversal = await fetchFile(plainViewer, "../outside.txt");
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ error: "Path must stay inside the project" });
    const absolute = await fetchFile(plainViewer, "/etc/passwd");
    expect(absolute.status).toBe(400);
    expect(await absolute.json()).toEqual({ error: "Absolute paths are not allowed" });
  });
});

function memberGit(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Real git repo with one commit; returns its HEAD. */
function initMemberRepo(dir) {
  write(dir, "main.ts", "export const v = 1;\n");
  memberGit(dir, "init");
  memberGit(dir, "config", "user.email", "viewer-tests@example.com");
  memberGit(dir, "config", "user.name", "Viewer Tests");
  memberGit(dir, "add", "--all");
  memberGit(dir, "commit", "-m", "baseline");
  return memberGit(dir, "rev-parse", "HEAD");
}

describe.skipIf(!existsSync(VIEWER_DIST))("understand-anything-viewer workspace staleness", () => {
  let tmp;
  let plainRoot;
  let viewer;
  let plainViewer;
  let freshHead;
  let staleRecorded;
  let motorHead;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ua-viewer-ws-fresh-"));
    freshHead = initMemberRepo(join(tmp, "brain"));
    staleRecorded = initMemberRepo(join(tmp, "motor"));
    write(join(tmp, "motor"), "main.ts", "export const v = 2;\n");
    memberGit(join(tmp, "motor"), "commit", "-am", "member change");
    motorHead = memberGit(join(tmp, "motor"), "rev-parse", "HEAD");
    write(tmp, "ws/.ua/knowledge-graph.json", JSON.stringify(graph(["brain/main.ts"], {
      name: "ws",
      members: [
        { ...MEMBERS[0], gitCommitHash: freshHead },
        { ...MEMBERS[1], gitCommitHash: staleRecorded },
      ],
    })));
    plainRoot = setupPlainProject();
    viewer = await startViewer(join(tmp, "ws"));
    plainViewer = await startViewer(plainRoot);
  }, 20_000);

  afterAll(() => {
    viewer?.proc.kill();
    plainViewer?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (plainRoot) rmSync(plainRoot, { recursive: true, force: true });
  });

  const fetchStaleness = (v) =>
    fetch(`http://127.0.0.1:${v.port}/staleness.json?token=${v.token}`);

  it("lists one fresh and one stale member", async () => {
    const res = await fetchStaleness(viewer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.graphs.knowledge).toHaveProperty("status");
    expect(body.workspace).toEqual({
      name: "ws",
      members: [
        { name: "brain", path: "../brain", status: "fresh", graphCommitHash: freshHead, headCommitHash: freshHead },
        { name: "motor", path: "../motor", status: "stale", graphCommitHash: staleRecorded, headCommitHash: motorHead },
      ],
    });
  });

  it("omits the workspace block for a non-workspace graph", async () => {
    const res = await fetchStaleness(plainViewer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.graphs.knowledge).toHaveProperty("status");
    expect(body).not.toHaveProperty("workspace");
  });
});

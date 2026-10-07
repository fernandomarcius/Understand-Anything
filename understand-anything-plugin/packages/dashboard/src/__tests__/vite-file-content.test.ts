import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSourceFile,
  resolveWorkspaceFilePath,
  workspaceMembersFromGraph,
} from "../../vite.config";

// Layout used by the workspace cases (members live OUTSIDE the workspace root,
// as in the manifest example of docs/multi-repo-workspace.md):
//
//   <tmp>/ws/.ua/knowledge-graph.json   workspace graph
//   <tmp>/brain/src/a.ts                member "brain" (path ../brain)
//   <tmp>/brain/notlisted.ts            on disk but not in the graph
//   <tmp>/motor/lib/b.py                member "motor" (path ../motor)
//   <tmp>/motor/link.txt -> <tmp>/outside/secret.txt   symlink escape
//   <tmp>/outside/secret.txt

let tempRoot: string;
let originalGraphDir: string | undefined;
let restoreCwd: (() => void) | undefined;

function write(relativePath: string, contents: string): string {
  const filePath = path.join(tempRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeGraph(projectDir: string, graph: unknown): void {
  write(`${projectDir}/.ua/knowledge-graph.json`, JSON.stringify(graph));
  process.env.GRAPH_DIR = path.join(tempRoot, projectDir);
}

function fileNode(filePath: string) {
  return { id: `file:${filePath}`, type: "file", name: path.basename(filePath), filePath };
}

const WORKSPACE_MEMBERS = [
  { name: "brain", path: "../brain", gitCommitHash: "a", analyzedAt: "x", nodes: 1, edges: 0 },
  { name: "motor", path: "../motor", gitCommitHash: "b", analyzedAt: "x", nodes: 2, edges: 0 },
];

function setupWorkspace(): void {
  write("brain/src/a.ts", "export const brain = 1;\n");
  write("brain/notlisted.ts", "export const hidden = true;\n");
  write("motor/lib/b.py", "motor = 2\n");
  const secret = write("outside/secret.txt", "TOP SECRET\n");
  fs.symlinkSync(secret, path.join(tempRoot, "motor", "link.txt"));
  writeGraph("ws", {
    project: { name: "ws", workspace: { name: "ws", members: WORKSPACE_MEMBERS } },
    nodes: [
      fileNode("brain/src/a.ts"),
      fileNode("motor/lib/b.py"),
      fileNode("motor/link.txt"),
      fileNode("ghost/src/a.ts"),
    ],
    edges: [],
  });
}

function request(filePath: string) {
  const url = new URL("http://127.0.0.1:5173/file-content.json");
  url.searchParams.set("token", "t");
  url.searchParams.set("path", filePath);
  return readSourceFile(url);
}

beforeEach(() => {
  originalGraphDir = process.env.GRAPH_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ua-file-content-"));
  // Keep the cwd fallback roots inside the fixture so a developer's own graph
  // never satisfies a request.
  const fixtureCwd = path.join(tempRoot, "runtime", "a", "b");
  fs.mkdirSync(fixtureCwd, { recursive: true });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixtureCwd);
  restoreCwd = () => cwd.mockRestore();
});

afterEach(() => {
  restoreCwd?.();
  restoreCwd = undefined;
  if (originalGraphDir === undefined) delete process.env.GRAPH_DIR;
  else process.env.GRAPH_DIR = originalGraphDir;
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("/file-content.json for workspace graphs", () => {
  beforeEach(setupWorkspace);

  it("serves a file from the first member", () => {
    const result = request("brain/src/a.ts");
    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      path: "brain/src/a.ts",
      language: "typescript",
      content: "export const brain = 1;\n",
    });
  });

  it("serves a file from the second member", () => {
    const result = request("motor/lib/b.py");
    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      path: "motor/lib/b.py",
      language: "python",
      content: "motor = 2\n",
    });
  });

  it.each([
    ["traversal out of the member", "brain/../../etc/passwd"],
    ["traversal into another member", "brain/../motor/lib/b.py"],
    ["undeclared member", "ghost/src/a.ts"],
    ["file not listed in the graph", "brain/notlisted.ts"],
    ["symlink pointing outside the member", "motor/link.txt"],
    ["absolute path", "/etc/passwd"],
    ["absolute path inside a member", path.join(os.tmpdir(), "brain/src/a.ts")],
  ])("rejects %s with 403", (_label, requested) => {
    const result = request(requested);
    expect(result.statusCode).toBe(403);
    expect(JSON.stringify(result.payload)).not.toContain("TOP SECRET");
  });
});

describe("/file-content.json for non-workspace graphs (unchanged)", () => {
  beforeEach(() => {
    write("proj/brain/src/a.ts", "export const plain = 1;\n");
    write("proj/secret.txt", "not in graph\n");
    writeGraph("proj", {
      project: { name: "proj" },
      nodes: [fileNode("brain/src/a.ts")],
      edges: [],
    });
  });

  it("serves a listed file relative to the project root", () => {
    const result = request("brain/src/a.ts");
    expect(result).toEqual({
      statusCode: 200,
      payload: {
        path: "brain/src/a.ts",
        language: "typescript",
        content: "export const plain = 1;\n",
        sizeBytes: 24,
        lineCount: 2,
      },
    });
  });

  it.each([
    ["secret.txt", 404, "File is not in the knowledge graph"],
    ["../outside.txt", 400, "Path must stay inside the project"],
    ["/etc/passwd", 400, "Absolute paths are not allowed"],
    ["", 400, "Missing path"],
  ])("keeps the original response for %j", (requested, statusCode, error) => {
    expect(request(requested)).toEqual({ statusCode, payload: { error } });
  });
});

describe("resolveWorkspaceFilePath", () => {
  beforeEach(setupWorkspace);

  const allowed = new Set(["brain/src/a.ts", "motor/lib/b.py", "motor/link.txt", "ghost/src/a.ts"]);
  const root = () => path.join(tempRoot, "ws");

  it("resolves a member file to its real path", () => {
    const result = resolveWorkspaceFilePath("motor/lib/b.py", root(), WORKSPACE_MEMBERS, allowed);
    expect(result).toEqual({
      ok: true,
      absoluteFile: fs.realpathSync(path.join(tempRoot, "motor", "lib", "b.py")),
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
    expect(resolveWorkspaceFilePath(requested, root(), WORKSPACE_MEMBERS, allowed)).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });
});

describe("workspaceMembersFromGraph", () => {
  it("returns null for a graph without project.workspace", () => {
    expect(workspaceMembersFromGraph({ project: { name: "p" } })).toBeNull();
    expect(workspaceMembersFromGraph(null)).toBeNull();
  });

  it("keeps only well-formed member entries", () => {
    expect(
      workspaceMembersFromGraph({
        project: {
          workspace: {
            members: [
              { name: "brain", path: "../brain" },
              { name: "Bad Name", path: "../x" },
              { name: "nopath" },
              "junk",
            ],
          },
        },
      }),
    ).toEqual([{ name: "brain", path: "../brain" }]);
  });
});

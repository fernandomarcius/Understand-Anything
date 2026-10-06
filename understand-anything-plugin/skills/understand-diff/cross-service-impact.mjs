#!/usr/bin/env node
/**
 * cross-service-impact.mjs — /understand-diff workspace mode.
 *
 * Maps per-member changed paths onto the merged workspace graph and reports
 * the cross-service impact: endpoints whose provider changed and their
 * consumers in other services (with file:line evidence), calls from changed
 * files into other services, message channels and shared tables touched.
 *
 * Usage:
 *   node cross-service-impact.mjs <workspaceRoot> --changes <changes.json>
 *        [--json] [--overlay] [--base <branch>]
 *
 *   changes.json  { "<member>": ["path/relative/to/member", ...], ... }
 *   --json        print { changedFiles, impact } instead of Markdown
 *   --overlay     write <dataDir>/diff-overlay.json for the dashboard
 *                 (changed + 1-hop affected + crossServiceNodeIds)
 *   --base        base branch recorded in the overlay
 *
 * Data dir rule: <workspaceRoot>/.understand-anything when present, else .ua.
 * Exit codes: 0 ok, 1 usage, 2 invalid input (missing/non-workspace graph,
 * unknown member, malformed changes file).
 */
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// skills/understand-diff/ -> plugin root is two dirs up
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  // Fallback: direct path for installed plugin cache layouts
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}
const {
  buildCrossServiceImpact,
  buildWorkspaceDiffOverlay,
  formatCrossServiceImpact,
  getWorkspaceMemberNames,
  namespaceChangedFiles,
} = core;

function fail(code, message) {
  process.stderr.write(`cross-service-impact: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { root: null, changes: null, json: false, overlay: false, base: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changes') args.changes = argv[++i];
    else if (a === '--base') args.base = argv[++i] ?? '';
    else if (a === '--json') args.json = true;
    else if (a === '--overlay') args.overlay = true;
    else if (!a.startsWith('--') && args.root === null) args.root = a;
    else fail(1, `unknown argument "${a}"`);
  }
  if (!args.root || !args.changes) {
    fail(1, 'usage: cross-service-impact.mjs <workspaceRoot> --changes <changes.json> [--json] [--overlay] [--base <branch>]');
  }
  return args;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(2, `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root);
const dataDir = existsSync(join(root, '.understand-anything')) ? join(root, '.understand-anything') : join(root, '.ua');
const graphPath = join(dataDir, 'knowledge-graph.json');
if (!existsSync(graphPath)) fail(2, `no knowledge graph at ${graphPath}; run /understand --workspace first`);
const graph = readJson(graphPath, 'knowledge graph');
if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail(2, `${graphPath} is not a knowledge graph`);

const members = getWorkspaceMemberNames(graph);
if (members.length === 0) fail(2, `${graphPath} is not a workspace graph (no project.workspace); use the single-repo flow`);

const changes = readJson(resolve(args.changes), 'changes file');
if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
  fail(2, 'changes file must be an object { "<member>": ["path", ...] }');
}
for (const [member, files] of Object.entries(changes)) {
  if (!members.includes(member)) fail(2, `unknown member "${member}" (workspace members: ${members.join(', ')})`);
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
    fail(2, `changes for member "${member}" must be an array of paths`);
  }
}

const changedFiles = Object.entries(changes).flatMap(([member, files]) => namespaceChangedFiles(member, files));
const impact = buildCrossServiceImpact(graph, changedFiles);

if (args.overlay) {
  const overlay = buildWorkspaceDiffOverlay(graph, changes, { baseBranch: args.base });
  writeFileSync(join(dataDir, 'diff-overlay.json'), `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
}

if (args.json) {
  process.stdout.write(`${JSON.stringify({ changedFiles, impact }, null, 2)}\n`);
} else {
  process.stdout.write(formatCrossServiceImpact(impact));
}

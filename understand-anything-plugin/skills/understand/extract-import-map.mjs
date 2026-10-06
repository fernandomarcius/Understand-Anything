#!/usr/bin/env node
/**
 * extract-import-map.mjs
 *
 * Deterministic import resolution script for the project-scanner agent.
 * Uses PluginRegistry (TreeSitterPlugin + non-code parsers) from
 * @understand-anything/core to extract raw import paths via tree-sitter,
 * then applies language-specific resolution rules to map them to
 * project-internal file paths.
 *
 * Replaces the LLM-written prose import resolver in agents/project-scanner.md
 * (the prose previously described patterns by language; runtime LLMs produced
 * inconsistent, regex-only scripts with sparse coverage).
 *
 * Usage:
 *   node extract-import-map.mjs <input.json> <output.json>
 *
 * Input JSON:
 *   {
 *     projectRoot: <abs-path>,
 *     files: [{ path, language, fileCategory }, ...],
 *     analysisPaths?: [<project-relative-path>, ...]
 *   }
 *
 * `files` is always the complete current inventory because import resolution
 * needs it for path/module probes. When `analysisPaths` is present, only those
 * files are read and emitted in `importMap`; omitting it preserves the original
 * full-scan behaviour.
 *
 * Output JSON:
 *   {
 *     scriptCompleted: true,
 *     stats: { filesScanned, filesWithImports, totalEdges },
 *     importMap: { <path>: [<resolvedPath>, ...], ... }
 *   }
 *
 * Logging: stderr only (stdout reserved for piped tools).
 * Per-file resilience: failures emit `Warning: extract-import-map: ...` and
 * set importMap[path] = [], they do not abort the script.
 */

import { createRequire } from 'node:module';
import { dirname, resolve, join, posix, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * Read a list of files concurrently while preserving result order. Failures
 * are returned in-place as `{ raw: null, err }` so callers can emit the same
 * per-file warnings they did under the previous sequential `readFileSync`
 * loops.
 *
 * `paths` is a list of `{ key, absPath }` pairs; `key` is whatever the caller
 * wants to attach the result to (typically a project-relative POSIX path).
 */
async function readFilesParallel(paths) {
  return Promise.all(
    paths.map(async ({ key, absPath }) => {
      try {
        const raw = await readFile(absPath, 'utf-8');
        return { key, raw, err: null };
      } catch (err) {
        return { key, raw: null, err };
      }
    }),
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// skills/understand/ -> plugin root is two dirs up
const pluginRoot = resolve(__dirname, '../..');
const require = createRequire(resolve(pluginRoot, 'package.json'));

// ---------------------------------------------------------------------------
// Resolve @understand-anything/core
//
// Node ESM dynamic import() requires a file:// URL on Windows; passing a raw
// absolute path like "C:\..." throws ERR_UNSUPPORTED_ESM_URL_SCHEME because the
// loader parses "C:" as a URL scheme. Wrap both resolutions in pathToFileURL().
// ---------------------------------------------------------------------------
let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  // Fallback: direct path for installed plugin cache layouts
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}

const { TreeSitterPlugin, PluginRegistry, builtinLanguageConfigs, registerAllParsers } = core;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a project-relative path to forward slashes (POSIX). Project-scanner
 * always emits forward slashes; we re-normalize to keep this script
 * cross-platform.
 */
function toPosix(p) {
  const separators = process.platform === 'win32' ? /[\\/]/ : /\//;
  return p.split(separators).filter(Boolean).join('/');
}

/**
 * Validate and normalize the optional selective-analysis path list. Keeping
 * this strict prevents an incremental caller from accidentally asking the
 * extractor to read outside projectRoot or silently miss a typo.
 */
function selectAnalysisFiles(files, analysisPaths) {
  if (analysisPaths === undefined) return files;
  if (!Array.isArray(analysisPaths)) {
    throw new Error('Invalid input: analysisPaths must be an array when provided');
  }

  const filesByPath = new Map();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path.length === 0) {
      throw new Error('Invalid input: every files entry must contain a non-empty path');
    }
    filesByPath.set(toPosix(file.path), file);
  }

  const selected = [];
  const seen = new Set();
  for (const rawPath of analysisPaths) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new Error('Invalid input: every analysisPaths entry must be a non-empty string');
    }
    // Use the host's path semantics here. On POSIX, backslashes and drive-like
    // prefixes are ordinary project-relative filename characters; on Windows,
    // path.isAbsolute also rejects drive-rooted and root-relative paths.
    if (isAbsolute(rawPath)) {
      throw new Error(`Invalid input: analysisPaths entry must be project-relative: ${rawPath}`);
    }
    const path = toPosix(rawPath);
    if (!path || path.split('/').some(part => part === '..')) {
      throw new Error(`Invalid input: analysisPaths entry escapes projectRoot: ${rawPath}`);
    }
    const file = filesByPath.get(path);
    if (!file) {
      throw new Error(`Invalid input: analysisPaths entry is not present in files: ${rawPath}`);
    }
    if (!seen.has(path)) {
      seen.add(path);
      selected.push(file);
    }
  }
  return selected;
}

// ECMAScript relational string comparison is lexicographic over UTF-16 code
// units, so path ordering is stable across ICU versions, locales, and hosts.
function comparePaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Join a directory with a relative segment, normalizing `.`/`..` segments and
 * returning a forward-slash POSIX path. Anchored at project root (no leading
 * slash). Returns '' if the path walks above the project root.
 */
function resolveRelative(dir, rel) {
  const parts = (dir ? dir.split('/').filter(Boolean) : []).concat(
    rel.split('/').filter(Boolean),
  );
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return '';
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * Return the directory portion of a project-relative path (no trailing slash,
 * '' for top-level files).
 */
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// Config loading
//
// Cached once at startup. Per-file resolvers consume these values; they MUST
// NOT re-read these files (a 1000-file project would otherwise re-parse the
// same config 1000 times).
// ---------------------------------------------------------------------------

/**
 * Parse a single tsconfig.json file content and return
 * `{ baseUrl: string, paths: Map<string, string[]> }` or `null` if both the
 * comment-stripped and raw parses fail. Centralizes the "JSONC-then-raw"
 * fallback so callers can iterate many tsconfigs without duplicating the
 * try/catch ladder.
 *
 * Returning `null` (rather than throwing) lets the caller emit a Warning:
 * with the exact tsconfig path that failed; bubbling the error would
 * conceal which file was at fault when many tsconfigs are loaded.
 */
function normalizeJsonc(raw) {
  let withoutComments = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      withoutComments += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      withoutComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) withoutComments += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        if (raw[i] === '\n') withoutComments += '\n';
        i++;
      }
      i++;
      continue;
    }
    withoutComments += ch;
  }

  let normalized = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      normalized += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      normalized += ch;
      continue;
    }
    if (ch === ',') {
      let nextIndex = i + 1;
      while (/\s/.test(withoutComments[nextIndex] ?? '')) nextIndex++;
      if (withoutComments[nextIndex] === '}' || withoutComments[nextIndex] === ']') continue;
    }
    normalized += ch;
  }
  return normalized.replace(/^\uFEFF/, '');
}

function parseTsConfigText(raw) {
  const normalized = normalizeJsonc(raw);
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const compilerOptions = parsed?.compilerOptions ?? {};
  // hasBaseUrl tracks whether baseUrl was set EXPLICITLY. Only then do bare
  // specifiers resolve against it (TypeScript semantics); the '.' default
  // exists solely to anchor `paths` targets.
  const hasBaseUrl = typeof compilerOptions.baseUrl === 'string';
  const baseUrl = hasBaseUrl ? compilerOptions.baseUrl : '.';
  const paths = new Map();
  if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
    for (const [alias, targets] of Object.entries(compilerOptions.paths)) {
      if (Array.isArray(targets)) {
        paths.set(alias, targets);
      }
    }
  }
  return { baseUrl, hasBaseUrl, paths };
}

/**
 * Load every `tsconfig.json` / `jsconfig.json` discovered in the input file
 * list and parse each. Returns `Map<dirPath, { baseUrl, hasBaseUrl, paths }>`
 * keyed by the project-relative POSIX directory containing the config (empty
 * string for a root-level config). jsconfig.json shares the tsconfig schema
 * (CRA / plain-JS projects); when both sit in one directory, tsconfig wins.
 *
 * `paths` keys keep their trailing `*` wildcards intact (e.g. `"@/*"`); the
 * resolver matches them by prefix. Values are arrays because tsconfig
 * allows multiple targets per alias.
 *
 * WHY plural: pnpm/yarn workspace monorepos commonly carry per-package
 * tsconfig.json files with package-scoped `paths` aliases. Loading only
 * the root tsconfig would (1) miss aliases defined in sub-packages and
 * (2) erroneously apply root aliases to files in sub-packages that
 * redefine them. Per-importer walk-up is the only correct behavior.
 *
 * Returns an empty map if no tsconfigs are found — many JS-only projects
 * have none, and relative imports still resolve without one. On parse
 * failure for a specific tsconfig, emits a Warning: pointing at the bad
 * file and skips it (the rest of the project keeps working).
 *
 * Parse strategy (per-file, in parseTsConfigText):
 *   1. Try the comment-stripped text (handles JSONC-style tsconfigs).
 *   2. If that fails, retry the ORIGINAL raw text — recovers the case
 *      where the stripper damaged a string literal containing `//`.
 *   3. If both fail, warn and skip — that tsconfig contributes no aliases.
 */
const TS_CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);

async function loadTsConfigs(projectRoot, files) {
  const out = new Map();
  // Which config name populated each dir in `out` — tsconfig.json wins over
  // a sibling jsconfig.json regardless of input order (TypeScript ignores
  // jsconfig when tsconfig is present).
  const sourceByDir = new Map();
  const warnings = [];
  const failures = [];
  // Collect the candidate paths in the original file order before reading,
  // so warning emit order matches the previous sequential implementation.
  const candidates = [];
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (!TS_CONFIG_NAMES.has(base)) continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }
  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    const configName = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      // absPath isn't carried through the helper return shape; reconstruct it.
      warnings.push(
        `Warning: extract-import-map: ${configName} at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — path aliases from this config will ` +
        `not be applied — relative imports unaffected\n`,
      );
      continue;
    }
    const parsed = parseTsConfigText(raw);
    if (!parsed) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: `invalid ${configName}`,
      });
      warnings.push(
        `Warning: extract-import-map: ${configName} at ${join(projectRoot, p)} failed ` +
        `to parse — path aliases from this config will not be applied ` +
        `— relative imports unaffected\n`,
      );
      continue;
    }
    const dir = dirOf(p);
    if (sourceByDir.get(dir) === 'tsconfig.json') continue;
    out.set(dir, parsed);
    sourceByDir.set(dir, configName);
  }
  return { configs: out, warnings, failures };
}

/**
 * Load every `go.mod` discovered in the input file list and extract its
 * `module <name>` line. Returns `Map<dirPath, moduleName>` where `dirPath`
 * is the project-relative POSIX directory containing the go.mod (empty
 * string for a root-level go.mod).
 *
 * WHY plural: multi-service / multi-module repositories (e.g. Google's
 * microservices-demo) have one go.mod per service. The resolver dispatches
 * per importer by walking up to the nearest go.mod, so a single root-only
 * lookup misses every file that lives inside a sub-module.
 *
 * Files outside the discovered `files[]` are ignored — the project-scanner
 * is the single source of truth for what the user considers part of the
 * project. On read failure for a discovered go.mod we silently skip that
 * entry; the per-file resolver will surface the "no ancestor go.mod" warning
 * if it matters for any importer.
 *
 * Example go.mod:
 *   module github.com/foo/bar
 *   go 1.21
 *
 * The resolver uses each module's prefix to translate
 * `import "github.com/foo/bar/x"` into the project-internal `x/<file>.go`.
 */
async function loadGoModules(projectRoot, files) {
  const out = new Map();
  // loadGoModules currently emits no warnings (read failures are silently
  // skipped — per-file resolvers surface "no ancestor go.mod" later), but
  // the `{ data, warnings }` shape matches loadTsConfigs / loadPhpAutoloads
  // so the concurrent caller in buildResolutionContext can drain them
  // uniformly in canonical order.
  const warnings = [];
  const failures = [];
  const candidates = [];
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'go.mod') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }
  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: go.mod at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — Go module imports may not resolve\n`,
      );
      continue;
    }
    let moduleName = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.replace(/\/\/.*$/, '').trim();
      if (!trimmed.startsWith('module ')) continue;
      moduleName = trimmed.slice('module '.length).trim();
      break;
    }
    if (!moduleName) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: 'module directive missing',
      });
      warnings.push(
        `Warning: extract-import-map: go.mod at ${join(projectRoot, p)} has no ` +
        `module directive — Go module imports may not resolve\n`,
      );
      continue;
    }
    out.set(dirOf(p), moduleName);
  }
  return { modules: out, warnings, failures };
}

/**
 * Parse Swift Package.swift target declarations just enough for import-map
 * resolution. Swift imports modules, and SwiftPM target names are module names.
 * The common convention is `Sources/<Target>`, but packages can override the
 * source directory with `path: "..."`; without this light manifest pass those
 * custom targets would stay disconnected.
 *
 * This is intentionally a focused parser, not a Swift evaluator. It handles
 * `.target(...)`, `.executableTarget(...)`, and `.testTarget(...)` calls with
 * literal `name:` and optional literal `path:` arguments.
 */
function parseSwiftPackageTargets(raw) {
  const targets = [];
  const callRe = /\.(target|executableTarget|testTarget)\s*\(/g;
  let match;

  while ((match = callRe.exec(raw)) !== null) {
    const kind = match[1];
    const bodyStart = callRe.lastIndex;
    let depth = 1;
    let i = bodyStart;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = raw.slice(bodyStart, i);
    callRe.lastIndex = i + 1;

    const name = body.match(/\bname\s*:\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const explicitPath = body.match(/\bpath\s*:\s*"([^"]+)"/)?.[1];
    const defaultRoot = kind === 'testTarget' ? 'Tests' : 'Sources';
    targets.push({
      name,
      path: explicitPath || `${defaultRoot}/${name}`,
    });
  }

  return targets;
}

async function loadSwiftPackageTargets(projectRoot, files) {
  const targets = new Map();
  const warnings = [];
  const failures = [];
  const candidates = [];

  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'Package.swift') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }

  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: Package.swift at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — Swift module imports may not resolve\n`,
      );
      continue;
    }
    const packageDir = dirOf(p);
    for (const target of parseSwiftPackageTargets(raw)) {
      const targetPath = resolveRelative(packageDir, target.path.replace(/\\/g, '/'));
      if (!targetPath) continue;
      if (!targets.has(target.name)) targets.set(target.name, new Set());
      targets.get(target.name).add(targetPath);
    }
  }

  return { targets, warnings, failures };
}

/**
 * Walk up from `startDir` (project-relative POSIX, '' for project root)
 * and return the DEEPEST ancestor directory that exists as a key in
 * `configMap`, or undefined if no ancestor matches.
 *
 * Determinism: ancestors are inspected from deepest to shallowest, so the
 * deepest match is always picked. This matches the way TS/JS / PHP / Go
 * tools resolve nearest config in the wild ("nearest enclosing").
 *
 * Defensive note: if multiple distinct keys somehow share a depth (cannot
 * happen with proper directory paths, but a malformed input could), the
 * caller is expected to have normalized the keys. We do not re-sort here
 * because the iteration order is determined by depth alone.
 */
function findNearestConfigDir(startDir, configMap) {
  if (configMap.size === 0) return undefined;
  // Walk ancestors from the importer's directory up to the project root.
  // Slicing the parts array gives every prefix; we test each from longest
  // to shortest so the deepest match wins.
  const parts = startDir ? startDir.split('/').filter(Boolean) : [];
  for (let i = parts.length; i >= 0; i--) {
    const ancestor = parts.slice(0, i).join('/');
    if (configMap.has(ancestor)) return ancestor;
  }
  return undefined;
}

/**
 * Resolution context shared across all per-file resolver calls. Holds:
 *  - fileSet: Set<string> of every input file's posix path
 *  - tsConfigs: Map<dir, { baseUrl, paths }> from every tsconfig.json in
 *    `files[]`. Per-import resolution walks up from the importer to the
 *    nearest enclosing tsconfig.
 *  - goModules: Map<dir, moduleName> from every go.mod in `files[]`.
 *  - phpAutoloads: Map<dir, autoloadMap> from every composer.json in
 *    `files[]`. Resolved paths are anchored at the composer's directory.
 *  - goFilesByDir: Map<dir, string[]> of .go files per directory (built
 *    once so Go's package-level import dispatch doesn't re-scan the file
 *    set per import).
 *
 * Build once; pass everywhere.
 */
async function buildResolutionContext(projectRoot, files) {
  const fileSet = new Set(files.map(f => toPosix(f.path)));

  // These config-loader passes are independent and each does its own
  // batched parallel I/O; run them concurrently so the wait for a slow
  // tsconfig.json read doesn't block go.mod / composer.json / SwiftPM scanning.
  //
  // Each loader BUFFERS warnings into a private array rather than writing
  // them to stderr inline. If a loader streamed warnings directly during
  // the concurrent passes, lines from independent loader families could
  // interleave based on I/O timing — that would break the pre-PR
  // deterministic order (ts → go → php → swift) and make stderr-diff verification
  // flaky. Drain the buffers in canonical order *after* Promise.all, so
  // a fixture with `(malformed tsconfig.json, malformed composer.json)`
  // always emits `tsconfig…\ncomposer…\n`, never the reverse.
  const [tsResult, goResult, phpResult, swiftResult] = await Promise.all([
    loadTsConfigs(projectRoot, files),
    loadGoModules(projectRoot, files),
    loadPhpAutoloads(projectRoot, files),
    loadSwiftPackageTargets(projectRoot, files),
  ]);
  for (const w of tsResult.warnings) process.stderr.write(w);
  for (const w of goResult.warnings) process.stderr.write(w);
  for (const w of phpResult.warnings) process.stderr.write(w);
  for (const w of swiftResult.warnings) process.stderr.write(w);
  const tsConfigs = tsResult.configs;
  const goModules = goResult.modules;
  const phpAutoloads = phpResult.autoloads;

  // Index .go files by their parent directory so the Go resolver can
  // expand a package-level import to all member .go files in O(1).
  const goFilesByDir = new Map();
  for (const f of files) {
    if (!f.path.endsWith('.go')) continue;
    const p = toPosix(f.path);
    const d = dirOf(p);
    if (!goFilesByDir.has(d)) goFilesByDir.set(d, []);
    goFilesByDir.get(d).push(p);
  }
  for (const arr of goFilesByDir.values()) {
    arr.sort(comparePaths);
  }

  // Build per-extension suffix indices for dotted-FQN resolvers (Java,
  // Kotlin, Scala). Indexed once; reused for every import dispatch. C# is
  // namespace-based and gets its own index (buildCSharpIndex) in main().
  const javaIndex = buildSuffixIndex(files, p => p.endsWith('.java'));
  const kotlinIndex = buildSuffixIndex(files, p => p.endsWith('.kt'));
  const scalaFilePredicate = p => p.endsWith('.scala') || p.endsWith('.sc');
  const scalaIndex = buildSuffixIndex(files, scalaFilePredicate);
  const scalaPackageIndex = buildPackageIndex(files, scalaFilePredicate);
  const swiftModuleIndex = buildSwiftModuleIndex(files, swiftResult.targets);

  return {
    projectRoot,
    fileSet,
    tsConfigs,
    goModules,
    goFilesByDir,
    javaIndex,
    kotlinIndex,
    scalaIndex,
    scalaPackageIndex,
    swiftModuleIndex,
    failures: [
      ...tsResult.failures,
      ...goResult.failures,
      ...phpResult.failures,
      ...swiftResult.failures,
    ],
    phpAutoloads,
    // Dedupe Sets for one-time-per-file warnings. Keyed by importer file
    // path. Mutated by resolvers.
    _warnedNoRustCrateRoot: new Set(),
    _warnedNoGoModule: new Set(),
  };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript resolver
//
// Handles:
//   - Relative imports: `import x from './foo'` -> `<dir>/foo` + ext probes
//   - tsconfig path aliases: `import x from '@/foo'` -> `<baseUrl>/<target>/foo`
//
// `imp.source` from tree-sitter is the literal string content of the import
// path (no quotes). We don't need to redo the regex work — we just classify
// the source string and dispatch.
// ---------------------------------------------------------------------------

// Extensions probed when the import has no extension. The order mirrors the
// historical project-scanner prose so behavior matches existing fixtures.
const TS_EXT_PROBES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
];

/**
 * NodeNext / Node16 / Bundler-with-explicit-extensions ESM TypeScript convention:
 * TypeScript does NOT rewrite import specifiers during compilation, so source
 * files import their COMPILED specifier (`./config.js`) even when only
 * `./config.ts` exists on disk. We map each compiled-output extension to the
 * TS source extensions that could have produced it, in priority order.
 *
 * Without this rewrite, ESM-TS projects (which is now the default for any new
 * TS project) end up with a near-edgeless knowledge graph because every
 * project-internal import fails to resolve. (#294)
 */
const NODENEXT_REWRITES = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs', '.ts'],
  '.cjs': ['.cts', '.cjs', '.ts'],
};

/**
 * Try ext probes against the file set for the given base path. Returns the
 * first matching project-relative path, or null. If the base path already has
 * a code extension AND exists in the file set, returns it directly.
 *
 * For NodeNext-style imports (`./foo.js` where only `./foo.ts` exists), apply
 * the source-extension rewrite — see NODENEXT_REWRITES above.
 */
function probeWithExtensions(basePath, fileSet) {
  if (!basePath) return null;
  // Exact match (import already had an extension that resolves on disk)
  if (fileSet.has(basePath)) return basePath;

  // NodeNext rewrite: if the basePath ends with a compiled-output extension
  // but no such file exists, try the corresponding source extensions. We do
  // this BEFORE the legacy "append extensions" loop because for an import
  // like `./foo.js`, appending `.ts` would produce `foo.js.ts` (always wrong)
  // while the correct candidate is `foo.ts`.
  for (const [outExt, srcExts] of Object.entries(NODENEXT_REWRITES)) {
    if (!basePath.endsWith(outExt)) continue;
    const stem = basePath.slice(0, -outExt.length);
    for (const srcExt of srcExts) {
      const candidate = stem + srcExt;
      if (fileSet.has(candidate)) return candidate;
    }
    // The basePath had an explicit compiled extension — don't fall through
    // to the "append extensions" loop, which would produce nonsense like
    // `foo.js.ts`. If NodeNext rewrite didn't find anything, return null.
    return null;
  }

  for (const ext of TS_EXT_PROBES) {
    const candidate = basePath + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a TypeScript / JavaScript import. Returns project-relative resolved
 * path or null. External packages return null.
 *
 * Path-alias resolution walks up from the importer's directory to find the
 * nearest enclosing tsconfig.json (monorepo-friendly). `baseUrl`-relative
 * targets are anchored at THAT tsconfig's directory, matching the way the
 * TypeScript compiler resolves nested project configs.
 */
export function resolveTsJsImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return null;
  const src = rawImport.trim();
  if (!src) return null;

  const importerDir = dirOf(toPosix(file.path));

  // Relative imports: ./foo, ../foo — tsconfig has no bearing here.
  if (src.startsWith('./') || src.startsWith('../')) {
    const base = resolveRelative(importerDir, src);
    return probeWithExtensions(base, ctx.fileSet);
  }

  // tsconfig path aliases. Walk up from the importer to find the nearest
  // tsconfig.json; resolve targets relative to THAT tsconfig's directory.
  // Without the walk-up, a root tsconfig would either swallow aliases that
  // belong to a sub-package or fail to apply sub-package-defined aliases.
  const tsConfigDir = findNearestConfigDir(importerDir, ctx.tsConfigs);
  if (tsConfigDir !== undefined) {
    const tsConfig = ctx.tsConfigs.get(tsConfigDir);
    const { baseUrl, hasBaseUrl, paths } = tsConfig;
    // baseUrl is tsconfig-dir-relative; '.', './', '' all mean the
    // tsconfig's own directory. We anchor at tsConfigDir so a nested
    // tsconfig's `baseUrl: '.'` maps to its package, not project root.
    const normalizedBase = baseUrl === '.' || baseUrl === ''
      ? ''
      : toPosix(baseUrl);
    let aliasMatched = false;
    if (paths && paths.size > 0) {
      for (const [alias, targets] of paths) {
        const aliasMatch = matchTsAlias(alias, src);
        if (aliasMatch === null) continue;
        aliasMatched = true;
        for (const target of targets) {
          const mapped = applyTsAlias(target, aliasMatch);
          const relativeToConfig = normalizedBase
            ? posix.join(normalizedBase, mapped)
            : mapped;
          // posix.normalize strips a leading "./" left over when both
          // tsConfigDir and normalizedBase are empty (root tsconfig with
          // `"@/*": ["./*"]`, the create-next-app default). Without this the
          // candidate stays as "./foo" while ctx.fileSet stores "foo", and
          // probeWithExtensions silently drops every cross-module edge.
          const candidate = posix.normalize(
            tsConfigDir
              ? posix.join(tsConfigDir, relativeToConfig)
              : relativeToConfig,
          );
          // Defensive: tsconfig targets shouldn't escape the project root.
          if (candidate.startsWith('..')) continue;
          const probed = probeWithExtensions(candidate, ctx.fileSet);
          if (probed) return probed;
        }
      }
    }

    // baseUrl fallback: with an EXPLICIT baseUrl, TypeScript (and CRA /
    // webpack through jsconfig/tsconfig) resolve a bare specifier relative
    // to it when no `paths` pattern matched — `baseUrl: "./src"` makes
    // `import x from 'api/client'` mean src/api/client.js. A matched alias
    // that failed to resolve does not fall through (TypeScript semantics).
    // The candidate only counts when it exists in the project file set, so
    // real packages (`react`, `lodash/fp`) stay external.
    if (hasBaseUrl && !aliasMatched && !src.startsWith('/')) {
      const candidate = posix.normalize(
        posix.join(tsConfigDir || '.', normalizedBase || '.', src),
      );
      if (candidate !== '..' && !candidate.startsWith('../')) {
        const probed = probeWithExtensions(candidate, ctx.fileSet);
        if (probed) return probed;
      }
    }
  }

  // Bare specifier with no leading `./`, no alias match -> external package.
  return null;
}

/**
 * Match an import against a tsconfig paths alias. Aliases use `*` as a single
 * wildcard, e.g. `"@/*"` matches `"@/foo/bar"` with the wildcard = "foo/bar".
 * Aliases without `*` must match exactly. Returns the wildcard content
 * (possibly '') on match, null on no match.
 */
function matchTsAlias(alias, src) {
  const starIdx = alias.indexOf('*');
  if (starIdx === -1) {
    return src === alias ? '' : null;
  }
  const prefix = alias.slice(0, starIdx);
  const suffix = alias.slice(starIdx + 1);
  if (!src.startsWith(prefix)) return null;
  if (!src.endsWith(suffix)) return null;
  // Avoid double-counting when prefix+suffix length exceeds src length
  if (src.length < prefix.length + suffix.length) return null;
  return src.slice(prefix.length, src.length - suffix.length);
}

/**
 * Substitute the wildcard content into a tsconfig target. Mirror of
 * matchTsAlias — if the target has no `*`, return it as-is (rare, but valid).
 */
function applyTsAlias(target, wildcard) {
  const starIdx = target.indexOf('*');
  if (starIdx === -1) return target;
  return target.slice(0, starIdx) + wildcard + target.slice(starIdx + 1);
}

/**
 * Tree-sitter's TS/JS extractor only records ES module `import` declarations.
 * CommonJS `require('./foo')` is treated as a generic call expression and
 * never enters `analysis.imports`, which would silently drop edges in
 * Node-style codebases. Patch coverage with a focused regex pass on the file
 * content — we only want literal string arguments, so the regex is narrow.
 *
 * Limitations (intentional):
 *   - Computed requires (`require(name)`) are external/dynamic — skipped.
 *   - Template-literal requires are unresolved.
 *   - String concatenation in the argument is unresolved.
 */
const REQUIRE_LITERAL_RE = /\brequire\(\s*(['"])([^'"`\n]+?)\1\s*\)/g;

/**
 * Strip JS/TS line and block comments before running text-pattern matchers.
 * Replaces with spaces (preserving offsets isn't critical here, but keeping
 * roughly the same length avoids surprising the matcher with collapsed
 * whitespace). Does not attempt to honor string contents — that's fine for
 * the narrow patterns we run (`require('...')`, etc.) because the same
 * comment-or-not heuristic applies uniformly to all matched literals.
 */
function stripJsLikeComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function extractRequireSources(content) {
  const sources = [];
  let m;
  const stripped = stripJsLikeComments(content);
  REQUIRE_LITERAL_RE.lastIndex = 0;
  while ((m = REQUIRE_LITERAL_RE.exec(stripped)) !== null) {
    sources.push(m[2]);
  }
  return sources;
}

/**
 * Kotlin has no tree-sitter extractor in this project, so we collect its
 * import sources via a focused regex pass. Kotlin imports are syntactically
 * simple: one per line, `import x.y.Z` or `import x.y.Z as Alias` (or
 * `import x.y.*` for star imports). We capture the dotted FQN and let the
 * dotted resolver classify wildcards.
 *
 * The capture is a strict qualifiedName grammar — a leading identifier
 * followed by zero or more `.identifier` segments and an optional trailing
 * `.*` for star-imports. The looser `[\w.*]+` form previously here would
 * match pathological inputs like `import ...` or `import .foo`.
 */
const KOTLIN_IMPORT_RE =
  /^\s*import\s+(\w+(?:\.\w+)*(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm;

function extractKotlinSources(content) {
  const sources = [];
  let m;
  KOTLIN_IMPORT_RE.lastIndex = 0;
  while ((m = KOTLIN_IMPORT_RE.exec(content)) !== null) {
    sources.push(m[1]);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Python resolver
//
// Python imports are parsed by `parsePythonImports` (below), not by the
// tree-sitter extractor: tree-sitter only reports module-level statements and
// records the ALIAS of `from . import repositorio as repo` instead of the
// imported name, which loses function-local imports (common in tests and in
// code avoiding import cycles) and breaks submodule probing. The parser
// yields one entry per statement:
//   - `import a.b.c [as z]`   -> { source: 'a.b.c', specifiers: [] }
//   - `from a.b.c import x,y` -> { source: 'a.b.c', specifiers: ['x','y'] }
//   - `from . import x as y`  -> { source: '.',     specifiers: ['x'] }
//   - `from .x import y`      -> { source: '.x',    specifiers: ['y'] }
//   - `from ..pkg import y`   -> { source: '..pkg', specifiers: ['y'] }
//
// Leading dots ALWAYS mean relative (Python's lexical convention).
//
// Resolution rules:
//   1. Relative (starts with `.`): walk up parent dirs by leading-dot count,
//      then descend by the remaining dotted segments.
//   2. Absolute (no leading dot): walk up from the importer's directory,
//      trying EACH ancestor as a candidate Python root. The first ancestor
//      under which probing succeeds wins. This matches how multi-service
//      Python repos work in practice — each service directory acts as its
//      own root for unqualified `import sibling` style imports
//      (e.g. microservices-demo's per-service grpc stubs). Importer-scope
//      precedence (deepest ancestor first) keeps same-named modules of
//      different services from cross-linking.
//   3. Absolute, not found by (2): probe the DISCOVERED package roots
//      (`buildPythonIndex`) — src-layout and multi-package monorepos where
//      `from csf_core.db import x` lives under `core/src/csf_core/`. Roots
//      come from pyproject.toml / setup.cfg / setup.py / pytest.ini (the
//      config dir, its `src/`, setuptools `where`/`package-dir`, hatch
//      `packages`, poetry `from`, pytest `pythonpath`) plus, per package
//      name, the parent of a unique top-level package imported from at
//      least two files. Stdlib names never take this path, and a root only
//      matches when the top-level package/module actually exists under it.
//
// Package edges: `from pkg import name` links `pkg/name.py` (or
// `pkg/name/__init__.py`) when `name` is a submodule, and links
// `pkg/__init__.py` only when `name` is NOT a submodule (it must come from
// the package) or `__init__.py` binds it (def/class/assignment/import or
// `__all__`). A bare `import pkg` links `pkg/__init__.py`.
// ---------------------------------------------------------------------------

// Top-level stdlib module names (CPython 3.8-3.14, including modules removed
// in 3.12/3.13). Never resolved through discovered/inferred roots.
const PY_STDLIB = new Set((
  '__future__ abc aifc annotationlib antigravity argparse array ast asynchat ' +
  'asyncio asyncore atexit audioop base64 bdb binascii binhex bisect builtins ' +
  'bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop ' +
  'collections colorsys compileall compression concurrent configparser ' +
  'contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses ' +
  'datetime dbm decimal difflib dis distutils doctest email encodings ' +
  'ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch ' +
  'formatter fractions ftplib functools gc genericpath getopt getpass gettext ' +
  'glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr ' +
  'imp importlib inspect io ipaddress itertools json keyword lib2to3 ' +
  'linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap ' +
  'modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath ' +
  'nturl2path numbers opcode operator optparse os ossaudiodev parser pathlib ' +
  'pdb pickle pickletools pipes pkgutil platform plistlib poplib posix ' +
  'posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc ' +
  'pydoc_data pyexpat queue quopri random re readline reprlib resource ' +
  'rlcompleter runpy sched secrets select selectors shelve shlex shutil ' +
  'signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ' +
  'sre_compile sre_constants sre_parse ssl stat statistics string stringprep ' +
  'struct subprocess sunau symbol symtable sys sysconfig syslog tabnanny ' +
  'tarfile telnetlib tempfile termios textwrap this threading time timeit ' +
  'tkinter token tokenize tomllib trace traceback tracemalloc tty turtle ' +
  'turtledemo types typing unicodedata unittest urllib uu uuid venv warnings ' +
  'wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp ' +
  'zipfile zipimport zlib zoneinfo'
).split(' '));

const PY_ID = '[\\p{L}_][\\p{L}\\p{N}_]*';
const PY_DOTTED = `${PY_ID}(?:\\s*\\.\\s*${PY_ID})*`;
const PY_FROM_RE = new RegExp(
  `^from(?=[\\s.])\\s*(\\.+(?:\\s*${PY_DOTTED})?|${PY_DOTTED})\\s*import(?=[\\s(*])\\s*(.+)$`, 'u',
);
const PY_IMPORT_RE = new RegExp(`^import\\s+(.+)$`, 'u');
const PY_NAME_RE = new RegExp(`^(${PY_ID}|\\*)(?:\\s+as\\s+(${PY_ID}))?$`, 'u');
const PY_MODULE_RE = new RegExp(`^(${PY_DOTTED})(?:\\s+as\\s+(${PY_ID}))?$`, 'u');
// `if TYPE_CHECKING: import x` / `try: import x` — single-line compound
// statement whose body is an import.
const PY_INLINE_BODY_RE =
  /^(?:try|else|finally|(?:el)?if\b[^:]*|except\b[^:]*|with\b[^:]*)\s*:\s*((?:from|import)\s.*)$/u;
const PY_DEF_RE = new RegExp(`^(?:async\\s+)?(?:def|class)\\s+(${PY_ID})`, 'u');
const PY_ASSIGN_RE = new RegExp(`^(${PY_ID})\\s*(?::[^=]*)?=(?!=)`, 'u');

/**
 * Split Python source into logical lines with comments removed and string
 * literals blanked to `""` (so docstrings that quote code never look like
 * imports). Bracketed continuations and backslash continuations are joined;
 * `;` splits statements. Leading indentation is dropped.
 */
export function pythonLogicalLines(content) {
  const src = content.replace(/\r\n?/g, '\n');
  const lines = [];
  let cur = '';
  let depth = 0;
  const n = src.length;
  const flush = () => {
    const t = cur.trim();
    if (t) lines.push(t);
    cur = '';
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = src.startsWith(ch + ch + ch, i);
      const q = triple ? ch + ch + ch : ch;
      i += q.length;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src.startsWith(q, i)) { i += q.length; break; }
        if (!triple && src[i] === '\n') break; // unterminated literal
        i++;
      }
      cur += '""';
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      cur += ' ';
      i += 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '\n') {
      if (depth > 0) cur += ' ';
      else flush();
      i++;
      continue;
    }
    if (ch === ';' && depth === 0) {
      flush();
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return lines;
}

/**
 * Parse every import statement of a Python file — module level, nested in
 * functions/classes, inside try/if blocks, parenthesized or continued.
 * Returns `[{ source, specifiers }]` with the IMPORTED names (aliases
 * dropped). `from __future__` is skipped.
 */
export function parsePythonImports(content) {
  const out = [];
  for (let line of pythonLogicalLines(content)) {
    const inline = line.match(PY_INLINE_BODY_RE);
    if (inline) line = inline[1];
    let m = line.match(PY_FROM_RE);
    if (m) {
      const source = m[1].replace(/\s+/g, '');
      if (source === '__future__') continue;
      const specifiers = [];
      for (const part of m[2].replace(/[()]/g, ' ').split(',')) {
        const nm = part.trim().match(PY_NAME_RE);
        if (nm) specifiers.push(nm[1]);
      }
      out.push({ source, specifiers });
      continue;
    }
    m = line.match(PY_IMPORT_RE);
    if (m) {
      for (const part of m[1].split(',')) {
        const mm = part.trim().match(PY_MODULE_RE);
        if (mm) out.push({ source: mm[1].replace(/\s+/g, ''), specifiers: [] });
      }
    }
  }
  return out;
}

/**
 * Names a module binds (approximation, any indentation): def/class names,
 * simple assignments, import bindings and `__all__` entries. Used to decide
 * whether `from pkg import name` touches `pkg/__init__.py`.
 */
export function pythonBoundNames(content) {
  const names = new Set();
  for (const line of pythonLogicalLines(content)) {
    let m = line.match(PY_DEF_RE);
    if (m) { names.add(m[1]); continue; }
    const body = (line.match(PY_INLINE_BODY_RE) || [null, line])[1];
    m = body.match(PY_FROM_RE);
    if (m) {
      for (const part of m[2].replace(/[()]/g, ' ').split(',')) {
        const nm = part.trim().match(PY_NAME_RE);
        if (nm && nm[1] !== '*') names.add(nm[2] || nm[1]);
      }
      continue;
    }
    m = body.match(PY_IMPORT_RE);
    if (m) {
      for (const part of m[1].split(',')) {
        const mm = part.trim().match(PY_MODULE_RE);
        if (mm) names.add(mm[2] || mm[1].split('.')[0].trim());
      }
      continue;
    }
    m = line.match(PY_ASSIGN_RE);
    if (m) names.add(m[1]);
  }
  // __all__ entries live inside string literals, which the logical-line
  // pass blanks — read them from the raw text.
  const allRe = /__all__\s*(?:\+=|=|:[^=\n]*=)\s*[[(]([\s\S]*?)[\])]/g;
  let a;
  while ((a = allRe.exec(content)) !== null) {
    for (const s of a[1].matchAll(/(['"])([^'"]+)\1/g)) names.add(s[2]);
  }
  return names;
}

/**
 * Normalize `rel` against `dir`; null when it escapes the project root or is
 * absolute.
 */
function pyJoinDir(dir, rel) {
  if (typeof rel !== 'string') return null;
  const r = rel.trim().replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[A-Za-z]:/.test(r)) return null;
  const stack = dir ? dir.split('/').filter(Boolean) : [];
  for (const part of r.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

const quotedStrings = text =>
  [...String(text).matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]);

/**
 * Minimal TOML scan: returns [{ section, key, value }] with multi-line
 * arrays/inline tables joined. Enough for the handful of path-valued keys
 * the Python root discovery reads; not a general TOML parser.
 */
function scanTomlEntries(raw) {
  const entries = [];
  let section = '';
  let pending = null;
  let depth = 0;
  const stripComment = line => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '#') return line.slice(0, i);
    }
    return line;
  };
  const countDepth = s => {
    let d = 0;
    let q = null;
    for (const c of s) {
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '[' || c === '{') d++;
      else if (c === ']' || c === '}') d--;
    }
    return d;
  };
  for (const rawLine of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const line = stripComment(rawLine);
    if (pending) {
      pending.value += ' ' + line.trim();
      depth += countDepth(line);
      if (depth <= 0) { entries.push(pending); pending = null; }
      continue;
    }
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    if (header) { section = header[1].replace(/["'\s]/g, ''); continue; }
    const kv = line.match(/^\s*([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const entry = { section, key: kv[1].replace(/["']/g, ''), value: kv[2].trim() };
    depth = countDepth(kv[2]);
    if (depth > 0) pending = entry;
    else entries.push(entry);
  }
  if (pending) entries.push(pending);
  return entries;
}

/**
 * Read declared Python roots (project-relative dirs) from one config file.
 * `cfgDir` is the config's directory; returned paths are not yet checked
 * for existence.
 */
function pythonRootsFromConfig(cfgPath, cfgDir, raw) {
  const roots = [];
  const add = rel => {
    const p = pyJoinDir(cfgDir, rel);
    if (p !== null) roots.push(p);
  };
  const base = cfgPath.slice(cfgPath.lastIndexOf('/') + 1);
  if (base === 'pyproject.toml') {
    for (const { section, key, value } of scanTomlEntries(raw)) {
      if (section === 'tool.setuptools.packages.find' && key === 'where') {
        quotedStrings(value).forEach(add);
      } else if (key === 'package-dir' || key === 'package_dir') {
        // setuptools: {"" = "src"}; pdm: package-dir = "src".
        if (value.startsWith('{')) {
          for (const m of value.matchAll(/(["'])(.*?)\1\s*=\s*(["'])(.*?)\3/g)) {
            if (m[2] === '') add(m[4]);
          }
        } else {
          quotedStrings(value).forEach(add);
        }
      } else if (section.startsWith('tool.hatch.build') && key === 'packages') {
        for (const p of quotedStrings(value)) {
          const full = pyJoinDir(cfgDir, p);
          if (full !== null) roots.push(dirOf(full));
        }
      } else if (section === 'tool.poetry' && key === 'packages') {
        for (const m of value.matchAll(/\bfrom\s*=\s*(["'])(.*?)\1/g)) add(m[2]);
      } else if (section === 'tool.pytest.ini_options' && key === 'pythonpath') {
        quotedStrings(value).flatMap(v => v.split(/\s+/)).filter(Boolean).forEach(add);
      }
    }
    return roots;
  }
  if (base === 'setup.cfg' || base === 'pytest.ini' || base === 'tox.ini') {
    // INI: `key = value` with indented continuation lines.
    let section = '';
    let current = null;
    const values = [];
    for (const rawLine of raw.replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*[#;]/.test(rawLine)) continue;
      const header = rawLine.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) { section = header[1].trim(); current = null; continue; }
      const kv = rawLine.match(/^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/);
      if (kv) {
        current = { section, key: kv[1], value: kv[2] };
        values.push(current);
      } else if (current && /^\s+\S/.test(rawLine)) {
        current.value += '\n' + rawLine.trim();
      }
    }
    for (const { section: s, key, value } of values) {
      if (s === 'options.packages.find' && key === 'where') {
        value.split(/\s+/).filter(Boolean).forEach(add);
      } else if (s === 'options' && key === 'package_dir') {
        for (const m of value.matchAll(/(?:^|\n)\s*=\s*(\S+)/g)) add(m[1]);
      } else if ((s === 'tool:pytest' || s === 'pytest') && key === 'pythonpath') {
        value.split(/\s+/).filter(Boolean).forEach(add);
      }
    }
    return roots;
  }
  if (base === 'setup.py') {
    for (const m of raw.matchAll(/package_dir\s*=\s*\{\s*(["'])\1\s*:\s*(["'])([^"']+)\2/g)) add(m[3]);
    for (const m of raw.matchAll(/find_(?:namespace_)?packages\(\s*(?:where\s*=\s*)?(["'])([^"']+)\1/g)) add(m[2]);
  }
  return roots;
}

const PY_ROOT_CONFIGS = new Set(['pyproject.toml', 'setup.cfg', 'setup.py', 'pytest.ini', 'tox.ini']);

/**
 * Build the Python resolution index once per run (reads the configs and the
 * FULL Python inventory, so narrowed `analysisPaths` runs infer the same
 * roots as full runs):
 *   - pyDirs:      dirs with at least one `.py` file below them
 *   - existingDirs: dirs containing any inventory file (for `<cfg>/src`)
 *   - initBindings: Map<`.../__init__.py`, Set<name> | null(unreadable)>
 *   - roots:       [{ dir, names: Set | null }] — declared (names null) then
 *                  inferred per package name
 */
async function buildPythonIndex(projectRoot, files, fileSet) {
  const warnings = [];
  const failures = [];
  const pyDirs = new Set();
  const existingDirs = new Set(['']);
  const pyFiles = [];
  for (const f of files) {
    const p = toPosix(f.path);
    let d = dirOf(p);
    while (d && !existingDirs.has(d)) { existingDirs.add(d); d = dirOf(d); }
    if (p.endsWith('.py')) {
      pyFiles.push(p);
      let pd = dirOf(p);
      while (pd && !pyDirs.has(pd)) { pyDirs.add(pd); pd = dirOf(pd); }
    }
  }
  pyFiles.sort(comparePaths);

  const cfgPaths = [...fileSet]
    .filter(p => PY_ROOT_CONFIGS.has(p.slice(p.lastIndexOf('/') + 1)))
    .sort(comparePaths);
  const [cfgReads, pyReads] = await Promise.all([
    readFilesParallel(cfgPaths.map(p => ({ key: p, absPath: join(projectRoot, p) }))),
    readFilesParallel(pyFiles.map(p => ({ key: p, absPath: join(projectRoot, p) }))),
  ]);

  const declared = [];
  const seenDeclared = new Set();
  const addDeclared = dir => {
    if (dir === null || seenDeclared.has(dir) || !existingDirs.has(dir)) return;
    seenDeclared.add(dir);
    declared.push({ dir, names: null });
  };
  for (const { key, raw, err } of cfgReads) {
    const cfgDir = dirOf(key);
    const base = key.slice(key.lastIndexOf('/') + 1);
    // Only packaging configs make their own dir (and its src/) a root;
    // pytest.ini/tox.ini contribute their explicit pythonpath only.
    if (base === 'pyproject.toml' || base === 'setup.cfg' || base === 'setup.py') {
      addDeclared(cfgDir);
      addDeclared(cfgDir ? `${cfgDir}/src` : 'src');
    }
    if (err) {
      failures.push({ path: key, stage: 'python-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: failed to read ${key} ` +
        `(${err.message}) — Python roots declared there are ignored\n`,
      );
      continue;
    }
    for (const r of pythonRootsFromConfig(key, cfgDir, raw)) addDeclared(r);
  }
  addDeclared('');

  // Per-name inferred roots: a top-level package imported (absolutely) from
  // at least two files, with exactly one top-level package dir of that name
  // in the inventory, contributes its parent dir as a root for that name.
  const importersByTop = new Map();
  const initBindings = new Map();
  for (const { key, raw } of pyReads) {
    if (key.endsWith('/__init__.py') || key === '__init__.py') {
      initBindings.set(key, raw === null ? null : pythonBoundNames(raw));
    }
    if (raw === null) continue;
    for (const imp of parsePythonImports(raw)) {
      if (imp.source.startsWith('.')) continue;
      const top = imp.source.split('.')[0];
      if (PY_STDLIB.has(top)) continue;
      if (!importersByTop.has(top)) importersByTop.set(top, new Set());
      importersByTop.get(top).add(key);
    }
  }
  const pkgDirsByName = new Map();
  for (const d of pyDirs) {
    const parent = dirOf(d);
    if (fileSet.has(parent ? `${parent}/__init__.py` : '__init__.py') && parent) continue;
    const name = d.slice(d.lastIndexOf('/') + 1);
    if (!pkgDirsByName.has(name)) pkgDirsByName.set(name, []);
    pkgDirsByName.get(name).push(d);
  }
  const inferred = new Map();
  for (const [top, importers] of [...importersByTop].sort((a, b) => comparePaths(a[0], b[0]))) {
    if (importers.size < 2) continue;
    const candidates = (pkgDirsByName.get(top) || []).filter(d => fileSet.has(`${d}/__init__.py`));
    if (candidates.length !== 1) continue;
    const parent = dirOf(candidates[0]);
    if (seenDeclared.has(parent)) continue;
    if (!inferred.has(parent)) inferred.set(parent, new Set());
    inferred.get(parent).add(top);
  }
  const roots = declared.concat(
    [...inferred].sort((a, b) => comparePaths(a[0], b[0])).map(([dir, names]) => ({ dir, names })),
  );

  return { pyDirs, initBindings, roots, warnings, failures };
}

/**
 * Resolve a Python import. Unlike most resolvers this can produce multiple
 * matches (the package `__init__.py` and/or one per submodule specifier),
 * so the signature differs: returns string[].
 *
 * Returns empty array for external/unresolved packages.
 */
export function resolvePythonImport(rawImport, specifiers, file, ctx) {
  // A package's own `__init__.py` doing `from . import x` would otherwise
  // link to itself when it also binds `x`.
  const self = toPosix(file.path);
  return resolvePythonImportTargets(rawImport, specifiers, file, ctx)
    .filter(p => p !== self);
}

function resolvePythonImportTargets(rawImport, specifiers, file, ctx) {
  if (typeof rawImport !== 'string') return [];
  const src = rawImport;
  const importerDir = dirOf(toPosix(file.path));

  // Count leading dots; the rest is a dotted module path
  let dots = 0;
  while (dots < src.length && src.charCodeAt(dots) === 0x2e /* '.' */) dots++;
  const tail = src.slice(dots);
  const tailSegments = tail ? tail.split('.').filter(Boolean) : [];

  if (dots > 0) {
    // Relative import. `from . import x` (dots=1, tail='') walks up zero
    // directories (sibling level); `from .. import x` walks up one.
    // Relative imports are anchored at the importer's package, so we do
    // NOT do the per-root walk-up here — leading dots already encode the
    // exact anchor.
    const importerParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
    const dropLevels = dots - 1;
    if (dropLevels > importerParts.length) {
      // Walked above the project root — unresolvable
      return [];
    }
    const baseParts = importerParts.slice(0, importerParts.length - dropLevels);

    // `from .[..] import x, y` with no dotted tail — the anchor package is
    // implicit and always "exists" (PEP 420 namespace packages need no
    // `__init__.py`), so probe the specifiers directly.
    if (tailSegments.length === 0) {
      return resolvePythonPackageMembers(baseParts.join('/'), specifiers, ctx);
    }

    const moduleParts = baseParts.concat(tailSegments);
    return resolvePythonProbe(moduleParts, specifiers, ctx);
  }

  if (tailSegments.length === 0) return [];

  // Absolute import, step 1: importer ancestors, deepest first.
  const importerParts = importerDir ? importerDir.split('/').filter(Boolean) : [];
  for (let i = importerParts.length; i >= 0; i--) {
    const rootParts = importerParts.slice(0, i);
    const candidateModule = rootParts.concat(tailSegments);
    const matches = resolvePythonProbe(candidateModule, specifiers, ctx);
    if (matches.length > 0) return matches;
  }

  // Step 2: discovered package roots (src-layout / multi-package repos).
  const py = ctx.python;
  const top = tailSegments[0];
  if (!py || PY_STDLIB.has(top)) return [];
  for (const root of orderPythonRoots(py.roots, importerParts)) {
    if (root.names && !root.names.has(top)) continue;
    const topPath = root.dir ? `${root.dir}/${top}` : top;
    const topExists =
      ctx.fileSet.has(`${topPath}.py`) ||
      ctx.fileSet.has(`${topPath}/__init__.py`) ||
      py.pyDirs.has(topPath);
    if (!topExists) continue;
    const rootParts = root.dir ? root.dir.split('/') : [];
    const matches = resolvePythonProbe(rootParts.concat(tailSegments), specifiers, ctx);
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Order roots for one importer: the root sharing the longest directory
 * prefix with the importer first (a package's own `src/` beats a sibling
 * package's), then by path for determinism.
 */
function orderPythonRoots(roots, importerParts) {
  const shared = dir => {
    if (!dir) return 0;
    const parts = dir.split('/');
    let k = 0;
    while (k < parts.length && k < importerParts.length && parts[k] === importerParts[k]) k++;
    return k;
  };
  return roots
    .map(r => ({ r, s: shared(r.dir) }))
    .sort((a, b) => (b.s - a.s) || comparePaths(a.r.dir, b.r.dir))
    .map(x => x.r);
}

/**
 * `from <pkg> import a, b` where `<pkg>` (dir `base`) is a package: each
 * specifier that is a submodule links that submodule; `__init__.py` is
 * linked when some specifier is not a submodule (or is `*`), when
 * `__init__.py` binds a specifier, or when there are no specifiers
 * (`import pkg`).
 */
function resolvePythonPackageMembers(base, specifiers, ctx) {
  const initPath = base ? `${base}/__init__.py` : '__init__.py';
  const hasInit = ctx.fileSet.has(initPath);
  const bound = hasInit ? ctx.python?.initBindings.get(initPath) : undefined;
  // Unknown bindings (no index / unreadable) -> keep the init edge.
  const initBinds = name => bound === undefined || bound === null || bound.has(name);
  const specs = Array.isArray(specifiers) ? specifiers : [];
  const matches = [];
  let needsInit = specs.length === 0;
  for (const spec of specs) {
    if (!spec || spec.includes('.')) continue;
    if (spec === '*') { needsInit = true; continue; }
    const subFile = base ? `${base}/${spec}.py` : `${spec}.py`;
    const subInit = base ? `${base}/${spec}/__init__.py` : `${spec}/__init__.py`;
    if (ctx.fileSet.has(subFile)) {
      matches.push(subFile);
      if (initBinds(spec)) needsInit = true;
    } else if (ctx.fileSet.has(subInit)) {
      matches.push(subInit);
      if (initBinds(spec)) needsInit = true;
    } else {
      needsInit = true;
    }
  }
  if (needsInit && hasInit) matches.unshift(initPath);
  return matches;
}

/**
 * Given a fully-qualified module-path segment list (e.g. ['src','utils']),
 * probe the file set for `a/b/c.py`, then the package `a/b/c/` (regular via
 * `__init__.py`, or a PEP 420 namespace dir holding `.py` files) whose
 * members are resolved by `resolvePythonPackageMembers`.
 */
function resolvePythonProbe(moduleParts, specifiers, ctx) {
  if (moduleParts.length === 0) return [];
  const base = moduleParts.join('/');
  const moduleFile = `${base}.py`;
  if (ctx.fileSet.has(moduleFile)) return [moduleFile];
  const isPackage =
    ctx.fileSet.has(`${base}/__init__.py`) || Boolean(ctx.python?.pyDirs.has(base));
  if (!isPackage) return [];
  return resolvePythonPackageMembers(base, specifiers, ctx);
}

// ---------------------------------------------------------------------------
// Go resolver
//
// Tree-sitter's Go extractor emits the literal import path (without quotes).
// Resolution: walk up from the importer's directory to find the nearest
// enclosing `go.mod` (multi-module monorepos are the norm). Strip that
// module's prefix; the remainder maps to a directory RELATIVE TO THAT
// MODULE'S DIRECTORY in the project. Go imports are package-level (not
// file-level), so a single `import "github.com/foo/bar/util"` produces edges
// to every .go file inside that module's `util/`.
//
// Cross-module imports (`github.com/foo/bar/X` from a file under a module
// that declares `github.com/foo/baz`) are correctly classified as external —
// they refer to a different Go module, which from this module's perspective
// is a third-party dependency.
//
// Inputs:
//   - rawImport: 'github.com/foo/bar/util' (no quotes)
//   - file.path: importer's project-relative path
//   - ctx.goModules: Map<dir, moduleName> of every go.mod discovered.
//
// Result: array of every `<moduleDir>/util/*.go` path in the project
// (deduped by caller).
// ---------------------------------------------------------------------------

export function resolveGoImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = rawImport.trim();
  if (!src) return [];

  const importerPath = toPosix(file.path);
  const importerDir = dirOf(importerPath);

  const nearestModuleDir = findNearestConfigDir(importerDir, ctx.goModules);
  if (nearestModuleDir === undefined) {
    // Warn once per importer file — a single .go file can import several
    // module-prefixed paths, so suppress duplicates.
    if (!ctx._warnedNoGoModule.has(importerPath)) {
      ctx._warnedNoGoModule.add(importerPath);
      process.stderr.write(
        `Warning: extract-import-map: Go file ${importerPath} has no ` +
        `ancestor go.mod — import ${src} unresolvable — module-prefix ` +
        `imports skipped\n`,
      );
    }
    return [];
  }

  const moduleName = ctx.goModules.get(nearestModuleDir);

  // Strip module prefix; require a `/` boundary so 'githubXcom...' does not
  // accidentally match 'github.com...'.
  let remainder;
  if (src === moduleName) {
    remainder = '';
  } else if (src.startsWith(moduleName + '/')) {
    remainder = src.slice(moduleName.length + 1);
  } else {
    // External package (stdlib, 3rd-party module, OR a different in-tree
    // module — the latter is intentional: from this module's perspective,
    // a sibling module is an external dependency).
    return [];
  }

  // Map to a directory in the project (POSIX style). Anchor at the module's
  // own directory, so a sub-module's `<module>/sub` resolves under that
  // module's tree rather than under project root.
  const subDir = toPosix(remainder);
  const targetDir = nearestModuleDir
    ? (subDir ? `${nearestModuleDir}/${subDir}` : nearestModuleDir)
    : subDir;
  const files = ctx.goFilesByDir.get(targetDir);
  return files ? [...files] : [];
}

// ---------------------------------------------------------------------------
// Dotted-package resolver (Java / Kotlin / C#)
//
// Shared logic: an import like `com.example.foo.Bar` maps to a file
// `**/com/example/foo/Bar.<ext>` in the project. Many JVM/CLR projects nest
// sources under `src/main/java/`, `src/main/kotlin/`, etc., so the resolver
// must search for any file whose suffix matches the dotted-path-as-file form.
//
// We pre-build an index: trailing-slash-suffix -> matching project paths.
// Indexing once is O(files * average_segments); per-import lookup is then
// effectively O(1) hash lookup + scan of the bucket.
// ---------------------------------------------------------------------------

/**
 * Build an index of all files for a given extension, keyed by their
 * "package-path suffix" form. For each file `src/main/java/com/x/Y.java`,
 * the index gets entries for every suffix that ends at a `/`:
 *   - 'com/x/Y.java'
 *   - 'x/Y.java'
 *   - 'Y.java'
 * keyed off each successively-shorter suffix.
 *
 * Using a Map<suffix, string[]> avoids per-import full table scans; a 50K-file
 * monorepo with deep package nesting still resolves O(1) per import.
 */
function buildSuffixIndex(files, extPredicate) {
  const idx = new Map();
  for (const f of files) {
    const p = toPosix(f.path);
    if (!extPredicate(p)) continue;
    // Generate every "directory-bounded suffix" of the path
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!idx.has(suffix)) idx.set(suffix, []);
      idx.get(suffix).push(p);
    }
  }
  // Deterministic order within each bucket
  for (const arr of idx.values()) {
    arr.sort(comparePaths);
  }
  return idx;
}

function buildPackageIndex(files, extPredicate) {
  const idx = new Map();
  for (const f of files) {
    const p = toPosix(f.path);
    if (!extPredicate(p)) continue;
    const dir = dirOf(p);
    if (!dir) continue;

    const parts = dir.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!idx.has(suffix)) idx.set(suffix, []);
      idx.get(suffix).push(p);
    }
  }
  for (const arr of idx.values()) {
    arr.sort(comparePaths);
  }
  return idx;
}

const SWIFT_SOURCE_ROOT_DIRS = new Set(['source', 'sources', 'test', 'tests']);
const SWIFT_MODULE_CONTAINER_DIRS = new Set([
  'framework',
  'frameworks',
  'library',
  'libraries',
  'module',
  'modules',
]);

function addSwiftModuleFile(index, moduleName, filePath) {
  if (!moduleName) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) return;
  if (!index.has(moduleName)) index.set(moduleName, new Set());
  index.get(moduleName).add(filePath);
}

function inferSwiftModulesFromPath(filePath) {
  const parts = filePath.split('/');
  const dirs = parts.slice(0, -1);
  const modules = new Set();

  for (let i = 0; i < dirs.length - 1; i++) {
    const lower = dirs[i].toLowerCase();
    if (
      SWIFT_SOURCE_ROOT_DIRS.has(lower) ||
      SWIFT_MODULE_CONTAINER_DIRS.has(lower)
    ) {
      modules.add(dirs[i + 1]);
    }
  }

  if (dirs.length > 0 && !SWIFT_SOURCE_ROOT_DIRS.has(dirs[0].toLowerCase())) {
    modules.add(dirs[0]);
  }

  return modules;
}

/**
 * Build a Swift module-name -> files index.
 *
 * Swift files in the same module do not import each other by relative path;
 * `import Foo` imports a module. We therefore resolve to every project Swift
 * file that belongs to module `Foo`, mirroring the Go resolver's package-level
 * expansion. The index combines SwiftPM manifest targets with common on-disk
 * conventions (`Sources/Foo`, `Tests/FooTests`, and top-level Xcode groups).
 */
function buildSwiftModuleIndex(files, packageTargets) {
  const idx = new Map();
  const targetEntries = [...packageTargets.entries()].map(([name, paths]) => [
    name,
    [...paths].sort(comparePaths),
  ]);

  for (const f of files) {
    const p = toPosix(f.path);
    if (!p.endsWith('.swift')) continue;
    if (p.endsWith('/Package.swift') || p === 'Package.swift') continue;

    for (const [moduleName, targetPaths] of targetEntries) {
      for (const targetPath of targetPaths) {
        if (p === targetPath || p.startsWith(`${targetPath}/`)) {
          addSwiftModuleFile(idx, moduleName, p);
        }
      }
    }

    for (const moduleName of inferSwiftModulesFromPath(p)) {
      addSwiftModuleFile(idx, moduleName, p);
    }
  }

  const out = new Map();
  for (const [moduleName, paths] of idx.entries()) {
    out.set(moduleName, [...paths].sort(comparePaths));
  }
  return out;
}

/**
 * Resolve a dotted-import to a file. `fqn` is the qualified name
 * (`com.example.Foo`); `ext` is the file extension to probe (`.java`,
 * `.kt`, `.scala`). Wildcards (e.g. `com.example.*`) and the trailing `*` in
 * Java's `com.example.*` are stripped before resolution — there is no good
 * single-file resolution for wildcards, so we drop them. (Tree-sitter
 * already exposes `*` as a specifier; the source field strips it.)
 *
 * Returns array (most cases: 0 or 1 match; multiple if the same suffix
 * appears in multiple source roots).
 */
function resolveDottedFqn(fqn, ext, suffixIndex) {
  if (!fqn || typeof fqn !== 'string') return [];
  // Strip trailing wildcard segments like `com.example.*`
  const trimmed = fqn.replace(/\.\*$/, '');
  if (!trimmed) return [];
  const filePart = trimmed.replace(/\./g, '/') + ext;
  const matches = suffixIndex.get(filePart);
  return matches ? [...matches] : [];
}

// ---------------------------------------------------------------------------
// Java resolver
// ---------------------------------------------------------------------------

export function resolveJavaImport(rawImport, _file, ctx) {
  return resolveDottedFqn(rawImport, '.java', ctx.javaIndex);
}

// ---------------------------------------------------------------------------
// Kotlin resolver
//
// Kotlin has no tree-sitter extractor in this project, so its import sources
// are collected via a focused regex pass in extractExtraImportSources(); the
// resolver itself is identical-shape to Java.
// ---------------------------------------------------------------------------

export function resolveKotlinImport(rawImport, _file, ctx) {
  return resolveDottedFqn(rawImport, '.kt', ctx.kotlinIndex);
}

// ---------------------------------------------------------------------------
// Scala resolver
//
// Scala imports come from the core ScalaExtractor in three shapes:
//   - plain:    `import com.example.Foo`      -> source='com.example.Foo',
//                                                specifiers=['Foo']
//   - selector: `import com.example.{A, B}`   -> source='com.example',
//                                                specifiers=['A', 'B']
//   - wildcard: `import com.example._` / `.*` -> source='com.example',
//                                                specifiers=['*']
//
// The plain source resolves like Java (`com/example/Foo.scala` suffix probe).
// Selector lists probe each specifier under the source package. Scala also
// allows package objects (`com/example/package.scala`) to hold members, so
// the package prefix is additionally probed against `<pkg>/package.scala`.
// Multi-type files (a `model.scala` holding many case classes) can't be
// resolved by name probing — same accepted limitation as Java/Kotlin/C#.
// ---------------------------------------------------------------------------

export function resolveScalaImport(rawImport, specifiers, _file, ctx) {
  const out = new Set();
  const specs = Array.isArray(specifiers) ? specifiers : [];
  const isPlain =
    specs.length === 1 &&
    specs[0] &&
    specs[0] !== '*' &&
    rawImport.endsWith(`.${specs[0]}`);

  if (specs.includes('*')) {
    for (const m of resolveScalaPackage(rawImport, ctx)) out.add(m);
    return [...out].sort(comparePaths);
  }

  if (isPlain) {
    for (const m of resolveScalaDottedFqn(rawImport, ctx)) out.add(m);
    if (out.size === 0) {
      const pkg = rawImport.slice(0, -(specs[0].length + 1));
      for (const m of resolveScalaDottedFqn(`${pkg}.package`, ctx)) out.add(m);
    }
    return [...out].sort(comparePaths);
  }

  let unresolvedSelector = false;
  for (const spec of specs) {
    if (!spec) continue;
    const matches = resolveScalaDottedFqn(`${rawImport}.${spec}`, ctx);
    if (matches.length === 0) unresolvedSelector = true;
    for (const m of matches) out.add(m);
  }

  if (unresolvedSelector) {
    for (const m of resolveScalaDottedFqn(`${rawImport}.package`, ctx)) out.add(m);
  }

  return [...out].sort(comparePaths);
}

function resolveScalaDottedFqn(fqn, ctx) {
  return [
    ...resolveDottedFqn(fqn, '.scala', ctx.scalaIndex),
    ...resolveDottedFqn(fqn, '.sc', ctx.scalaIndex),
  ];
}

function resolveScalaPackage(pkg, ctx) {
  if (!pkg || typeof pkg !== 'string') return [];
  const dirPart = pkg.replace(/\.\*$/, '').replace(/\./g, '/');
  const matches = ctx.scalaPackageIndex.get(dirPart);
  return matches ? [...matches].sort(compareScalaPackageMembers) : [];
}

function compareScalaPackageMembers(a, b) {
  const aPackage = /\/package\.s(?:cala|c)$/.test(a);
  const bPackage = /\/package\.s(?:cala|c)$/.test(b);
  if (dirOf(a) === dirOf(b) && aPackage !== bPackage) return aPackage ? 1 : -1;
  return comparePaths(a, b);
}

// ---------------------------------------------------------------------------
// C# resolver (namespace-based)
//
// C# has no file-level imports: `using A.B.C;` brings a NAMESPACE into scope,
// and a namespace is declared per file (`namespace A.B.C;` file-scoped or
// `namespace A.B.C { ... }` block-scoped), usually spanning many files and
// often several .csproj projects of one solution. Namespaces rarely mirror
// the directory layout (`namespace Api_Foo.Application` under `API/Application/`),
// so probing `A/B/C.cs` as a path (the Java/Kotlin strategy) resolves nothing.
//
// Strategy (deterministic, no tree-sitter needed):
//   1. Read every .cs file of the inventory once and build
//      namespace -> typeName -> [files] from top-level type declarations
//      (class/interface/struct/enum/record/delegate).
//   2. For each file, the visible namespaces are: its own namespaces and all
//      of their parents (C# lookup walks enclosing namespaces), the global
//      namespace, its `using` namespaces, and the `global using` namespaces of
//      its project (nearest ancestor .csproj; the whole repo when none).
//   3. An edge exists only when the file actually references an identifier
//      that a visible namespace declares — `using X;` alone links nothing, so a
//      big namespace does not explode into edges to every member file.
//      `using static X.Y.T;` links T's file directly; `using A = X.Y.T;` links
//      T's file when `A` is used; fully qualified `X.Y.T` references resolve
//      without any using.
//   4. Comments, string contents and preprocessor lines are ignored
//      (interpolation holes are code). Generated sources — anything under a
//      bin/ or obj/ folder, and Migrations/*.Designer.cs — are neither indexed
//      nor given edges. Self-edges are dropped.
// ---------------------------------------------------------------------------

/** True for generated C# sources that must not take part in the import map. */
export function isGeneratedCSharpPath(p) {
  const parts = p.split('/');
  const dirs = parts.slice(0, -1).map(s => s.toLowerCase());
  if (dirs.includes('bin') || dirs.includes('obj')) return true;
  return parts[parts.length - 1].endsWith('.Designer.cs') && dirs.includes('migrations');
}

/**
 * Return the code of a C# source with comments, string/char literal contents
 * and preprocessor lines blanked out. Interpolation holes (`$"{expr}"`) are
 * kept as code, with their braces blanked so namespace brace-depth tracking is
 * not disturbed.
 */
export function stripCSharpNoise(src) {
  const out = [];
  const n = src.length;
  let i = 0;

  function skipCharLiteral() {
    i++; // opening '
    while (i < n && src[i] !== "'" && src[i] !== '\n') {
      if (src[i] === '\\') i++;
      i++;
    }
    i++; // closing '
    out.push(' ');
  }

  // Scan an interpolation hole up to (not including) its closing brace.
  function scanHole() {
    out.push(' ');
    scanCode(true);
    out.push(' ');
  }

  function scanString() {
    let dollars = 0;
    let verbatim = false;
    while (src[i] === '$' || src[i] === '@') {
      if (src[i] === '$') dollars++;
      else verbatim = true;
      i++;
    }
    let quotes = 0;
    while (src[i + quotes] === '"') quotes++;

    if (!verbatim && quotes >= 3) {
      // Raw string literal: ends at the same number of consecutive quotes.
      i += quotes;
      while (i < n) {
        if (src[i] === '"') {
          let k = 0;
          while (src[i + k] === '"') k++;
          i += k;
          if (k >= quotes) break;
          continue;
        }
        if (dollars > 0 && src[i] === '{') {
          let k = 0;
          while (src[i + k] === '{') k++;
          i += k;
          if (k >= dollars) {
            scanHole();
            while (i < n && src[i] === '}') i++;
          }
          continue;
        }
        i++;
      }
      out.push(' ');
      return;
    }

    i++; // opening quote
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        if (verbatim && src[i + 1] === '"') { i += 2; continue; }
        i++;
        break;
      }
      if (!verbatim && c === '\\') { i += 2; continue; }
      if (!verbatim && c === '\n') break; // unterminated literal: stop at EOL
      if (dollars > 0 && c === '{') {
        if (src[i + 1] === '{') { i += 2; continue; }
        i++;
        scanHole();
        if (src[i] === '}') i++;
        continue;
      }
      i++;
    }
    out.push(' ');
  }

  function startsString(at) {
    let j = at;
    while (src[j] === '$' || src[j] === '@') j++;
    return src[j] === '"';
  }

  function scanCode(stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        out.push(' ');
        continue;
      }
      if (c === '#') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === "'") { skipCharLiteral(); continue; }
      if (c === '"' || ((c === '$' || c === '@') && startsString(i))) {
        scanString();
        continue;
      }
      if (stopAtBrace && (c === '{' || c === '}')) {
        if (c === '}' && depth === 0) return;
        depth += c === '{' ? 1 : -1;
        out.push(' ');
        i++;
        continue;
      }
      out.push(c);
      i++;
    }
  }

  scanCode(false);
  return out.join('');
}

const CS_TOKEN_RE = /@?[\p{L}_][\p{L}\p{Nd}_]*|::|[{};=(),.<>]/gu;
const CS_IDENT_RE = /^@?[\p{L}_]/u;
const CS_TYPE_KEYWORDS = new Set(['class', 'interface', 'struct', 'enum', 'record']);
// Tokens that may follow a type keyword without it being a declaration
// (generic constraints such as `where T : class, new()` / `where U : struct`).
const CS_NOT_A_TYPE_NAME = new Set(['where', 'new', 'class', 'struct']);

/**
 * Parse one C# source into the facts the namespace resolver needs:
 *   namespaces — namespaces declared in the file (full dotted names)
 *   types      — [{ ns, name }] top-level type declarations
 *   usings     — [{ target, alias, isStatic, isGlobal, scope }]
 *   idents     — identifiers referenced outside using/namespace directives
 *   chains     — dotted identifier chains (`A.B.C`), for qualified references
 */
export function parseCSharpSource(src) {
  const code = stripCSharpNoise(src);
  const toks = code.match(CS_TOKEN_RE) ?? [];
  const isIdent = t => t !== undefined && CS_IDENT_RE.test(t);
  const bare = t => (t[0] === '@' ? t.slice(1) : t);

  const namespaces = new Set();
  const types = [];
  const usings = [];
  const idents = new Set();
  const chains = new Set();

  const stack = []; // { kind: 'ns', name } | { kind: 'other' }
  let otherDepth = 0;
  let fileNs = '';
  let pendingNs = null;
  let chain = [];

  const currentNs = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind === 'ns') return stack[k].name;
    }
    return fileNs;
  };
  const flushChain = () => {
    if (chain.length >= 2) chains.add(chain.join('.'));
    chain = [];
  };
  // Read `Ident(.Ident)*` starting at toks[t]; returns [name, nextIndex].
  const readQualified = t => {
    if (toks[t] === 'global' && toks[t + 1] === '::') t += 2;
    const parts = [];
    while (isIdent(toks[t])) {
      parts.push(bare(toks[t]));
      if (toks[t + 1] !== '.') { t++; break; }
      t += 2;
    }
    return [parts.join('.'), t];
  };

  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];

    if (tok === '{') {
      flushChain();
      if (pendingNs !== null) {
        stack.push({ kind: 'ns', name: pendingNs });
        pendingNs = null;
      } else {
        stack.push({ kind: 'other' });
        otherDepth++;
      }
      continue;
    }
    if (tok === '}') {
      flushChain();
      const top = stack.pop();
      if (top && top.kind === 'other') otherDepth--;
      continue;
    }

    if (otherDepth === 0) {
      if (tok === 'namespace') {
        flushChain();
        const [name, next] = readQualified(t + 1);
        if (name) {
          const outer = currentNs();
          const full = outer ? `${outer}.${name}` : name;
          namespaces.add(full);
          if (toks[next] === ';') fileNs = full;
          else pendingNs = full;
        }
        t = next - 1; // let the `{` / `;` be processed normally
        continue;
      }
      if (tok === 'using' || (tok === 'global' && toks[t + 1] === 'using')) {
        flushChain();
        let u = tok === 'global' ? t + 2 : t + 1;
        const isGlobal = tok === 'global';
        let isStatic = false;
        let alias = null;
        if (toks[u] === 'static') { isStatic = true; u++; }
        if (isIdent(toks[u]) && toks[u + 1] === '=') { alias = bare(toks[u]); u += 2; }
        const [target, next] = readQualified(u);
        let end = next;
        while (end < toks.length && toks[end] !== ';' && toks[end] !== '{' && toks[end] !== '}') end++;
        if (target && toks[end] === ';') {
          usings.push({ target, alias, isStatic, isGlobal, scope: currentNs() });
          t = end;
          continue;
        }
        // Not a directive (e.g. `using (...)`): fall through as plain tokens.
      }
      if (CS_TYPE_KEYWORDS.has(tok)) {
        let nameAt = t + 1;
        if (tok === 'record' && (toks[nameAt] === 'class' || toks[nameAt] === 'struct')) nameAt++;
        const name = toks[nameAt];
        if (isIdent(name) && !CS_NOT_A_TYPE_NAME.has(name)) {
          types.push({ ns: currentNs(), name: bare(name) });
          flushChain();
          t = nameAt; // the declared name is not a reference
          continue;
        }
      }
      if (tok === 'delegate') {
        // `delegate Ret<Generic> Name<T>(...)`: the name is the last
        // identifier at angle depth 0 before `(`; anonymous `delegate (...)`
        // has fewer than two and is skipped.
        let angle = 0;
        let last = null;
        let count = 0;
        let k = t + 1;
        for (; k < toks.length && toks[k] !== '(' && toks[k] !== ';' && toks[k] !== '{'; k++) {
          if (toks[k] === '<') angle++;
          else if (toks[k] === '>') angle--;
          else if (angle === 0 && isIdent(toks[k])) { last = bare(toks[k]); count++; }
        }
        if (toks[k] === '(' && count >= 2) types.push({ ns: currentNs(), name: last });
      }
    }

    if (isIdent(tok)) {
      const name = bare(tok);
      idents.add(name);
      if (chain.length > 0 && toks[t - 1] === '.') chain.push(name);
      else { flushChain(); chain.push(name); }
    } else if (tok !== '.') {
      flushChain();
    }
  }
  flushChain();

  return { namespaces, types, usings, idents, chains };
}

/**
 * Read and index every .cs file of the inventory once. The index is shared by
 * all per-file resolutions (O(files) build, O(identifiers x visible
 * namespaces) per file).
 */
async function buildCSharpIndex(projectRoot, files) {
  const csPaths = [];
  const projectDirs = [];
  for (const f of files) {
    const p = toPosix(f.path);
    if (p.endsWith('.csproj')) projectDirs.push(dirOf(p));
    else if (p.endsWith('.cs') && !isGeneratedCSharpPath(p)) csPaths.push(p);
  }
  // Longest first so the nearest ancestor .csproj wins.
  projectDirs.sort((a, b) => b.length - a.length || comparePaths(a, b));
  const projectOf = p => {
    for (const d of projectDirs) {
      if (d === '' || p.startsWith(`${d}/`)) return d;
    }
    return '';
  };

  const reads = await readFilesParallel(
    csPaths.map(p => ({ key: p, absPath: join(projectRoot, p) })),
  );

  const parsed = new Map();
  const typesByNs = new Map();
  const globalUsingsByProject = new Map();
  for (const { key, raw } of reads) {
    if (raw === null) continue; // the per-file loop reports read failures
    let info;
    try {
      info = parseCSharpSource(raw);
    } catch {
      continue;
    }
    parsed.set(key, info);
    for (const { ns, name } of info.types) {
      if (!typesByNs.has(ns)) typesByNs.set(ns, new Map());
      const byName = typesByNs.get(ns);
      if (!byName.has(name)) byName.set(name, []);
      const arr = byName.get(name);
      if (!arr.includes(key)) arr.push(key);
    }
    const globals = info.usings.filter(u => u.isGlobal);
    if (globals.length > 0) {
      const proj = projectOf(key);
      if (!globalUsingsByProject.has(proj)) globalUsingsByProject.set(proj, []);
      globalUsingsByProject.get(proj).push(...globals);
    }
  }

  return { parsed, typesByNs, globalUsingsByProject, projectOf };
}

/** Yield `ns` and every enclosing namespace (`A.B.C`, `A.B`, `A`). */
function csNamespaceChain(ns) {
  const out = [];
  let cur = ns;
  while (cur) {
    out.push(cur);
    const k = cur.lastIndexOf('.');
    cur = k < 0 ? '' : cur.slice(0, k);
  }
  return out;
}

/**
 * Resolve one C# file to the project files declaring the types it references.
 * `content` is used only when the file is missing from the prebuilt index.
 */
export function resolveCSharpFile(path, content, idx) {
  if (isGeneratedCSharpPath(path)) return [];
  const info = idx.parsed.get(path) ?? parseCSharpSource(content);
  const out = new Set();

  const addType = (ns, name) => {
    const hits = idx.typesByNs.get(ns)?.get(name);
    if (!hits) return false;
    for (const f of hits) out.add(f);
    return true;
  };
  const addFqnType = fqn => {
    const k = fqn.lastIndexOf('.');
    return addType(k < 0 ? '' : fqn.slice(0, k), k < 0 ? fqn : fqn.slice(k + 1));
  };

  // Global namespace + own namespaces with all of their parents.
  const visible = new Set(['']);
  for (const ns of info.namespaces) {
    for (const p of csNamespaceChain(ns)) visible.add(p);
  }

  const usings = [
    ...info.usings,
    ...(idx.globalUsingsByProject.get(idx.projectOf(path)) ?? []),
  ];
  for (const u of usings) {
    if (u.alias !== null && !info.idents.has(u.alias)) continue;
    // A using inside `namespace N { ... }` may be relative to N or its parents.
    const candidates = [u.target, ...csNamespaceChain(u.scope).map(s => `${s}.${u.target}`)];
    for (const target of candidates) {
      if (u.isStatic) {
        if (addFqnType(target)) break;
      } else if (idx.typesByNs.has(target)) {
        visible.add(target);
        break;
      } else if (addFqnType(target)) {
        // `using X.Y.Type;` / `using A = X.Y.Type;` naming a type directly.
        break;
      }
    }
  }

  for (const id of info.idents) {
    for (const ns of visible) addType(ns, id);
  }
  for (const chain of info.chains) {
    const segs = chain.split('.');
    for (let k = 1; k < segs.length; k++) {
      addType(segs.slice(0, k).join('.'), segs[k]);
    }
  }

  out.delete(path);
  return [...out].sort(comparePaths);
}

// ---------------------------------------------------------------------------
// Swift resolver
//
// Swift imports modules, not files. `SwiftExtractor` reports the module part
// as `imp.source` for both `import Foo` and qualified forms such as
// `import struct Foo.Bar`. If a project module named Foo exists in the Swift
// module index, map the import to all Swift files in that module.
// ---------------------------------------------------------------------------

function normalizeSwiftModuleName(rawImport) {
  if (!rawImport || typeof rawImport !== 'string') return null;
  const moduleName = rawImport.trim().split('.')[0];
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName) ? moduleName : null;
}

export function resolveSwiftImport(rawImport, file, ctx) {
  const moduleName = normalizeSwiftModuleName(rawImport);
  if (!moduleName) return [];
  const matches = ctx.swiftModuleIndex.get(moduleName);
  if (!matches) return [];
  const importer = toPosix(file.path);
  return matches.filter(p => p !== importer);
}

// ---------------------------------------------------------------------------
// Ruby resolver
//
// Two distinct Ruby import forms, with different resolution semantics:
//   - `require_relative 'foo'`  -> resolve against the importer's directory,
//                                  append .rb
//   - `require 'foo/bar'`       -> load-path probe: lib/foo/bar.rb,
//                                  app/foo/bar.rb, or foo/bar.rb (whichever
//                                  exists)
//
// Tree-sitter's Ruby extractor uses a single `imports` field for both forms
// and drops the method name, so we cannot tell them apart from the
// extractor output alone. Instead we use a regex pass on the file content,
// which preserves the method name as the discriminator.
//
// The two forms are unambiguous in source — both start with the method name
// followed by a quoted argument — so a focused regex is reliable.
// ---------------------------------------------------------------------------

const RUBY_REQUIRE_RE =
  /\b(require_relative|require)\s*\(?\s*(['"])([^'"`\n]+?)\2/g;

/**
 * Strip Ruby line comments (`# ...` to end of line) before running the
 * require regex. Ruby has no block comments at this scope (=begin/=end
 * exists but is rare; tree-sitter would normally handle that). Like the JS
 * stripper, this doesn't try to honor string contents — it's a heuristic.
 */
function stripRubyComments(content) {
  return content.replace(/#[^\n]*/g, '');
}

/**
 * Return [{ kind: 'relative'|'absolute', source }] for every require /
 * require_relative call in a Ruby file.
 */
function parseRubyImports(content) {
  const out = [];
  let m;
  const stripped = stripRubyComments(content);
  RUBY_REQUIRE_RE.lastIndex = 0;
  while ((m = RUBY_REQUIRE_RE.exec(stripped)) !== null) {
    out.push({
      kind: m[1] === 'require_relative' ? 'relative' : 'absolute',
      source: m[3],
    });
  }
  return out;
}

/**
 * Resolve a single Ruby require. Returns array (0 or 1 match).
 *
 * For require_relative: append `.rb` if missing, resolve against importer dir.
 * For require: probe lib/<src>.rb, app/<src>.rb, <src>.rb.
 */
export function resolveRubyImport({ kind, source }, file, ctx) {
  if (!source) return [];
  const importerDir = dirOf(toPosix(file.path));
  const withExt = source.endsWith('.rb') ? source : source + '.rb';

  if (kind === 'relative') {
    const base = resolveRelative(importerDir, withExt);
    return ctx.fileSet.has(base) ? [base] : [];
  }

  // Load-path probe order
  const probes = [`lib/${withExt}`, `app/${withExt}`, withExt];
  for (const p of probes) {
    if (ctx.fileSet.has(p)) return [p];
  }
  return [];
}

// ---------------------------------------------------------------------------
// PHP resolver
//
// PHP's `use Vendor\Pkg\Class;` is namespace-based. Composer's PSR-4
// autoload map (`composer.json` -> autoload.psr-4) declares which directory
// holds the files for each namespace prefix, e.g.:
//   { "App\\": "src/" }  means App\Foo\Bar lives at src/Foo/Bar.php
//
// Resolution:
//   1. Find the longest matching autoload prefix.
//   2. Strip that prefix from the FQN.
//   3. Translate backslashes to forward slashes.
//   4. Append `.php` and probe the file set.
//
// Imports whose namespace is not declared in any autoload entry are
// external — dropped.
// ---------------------------------------------------------------------------

/**
 * Parse a single composer.json content and return Map<namespacePrefix,
 * dir[]> or null if the JSON failed to parse. The returned dirs are
 * relative to the composer.json's own directory — NOT projectRoot —
 * matching how PSR-4 itself is specified.
 *
 * Returning `null` (rather than throwing) lets the caller emit a Warning:
 * with the exact composer.json path that failed; bubbling the error would
 * conceal which file was at fault when many composer.json files are loaded.
 */
function parseComposerAutoloadText(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const out = new Map();
  const psr4 = parsed?.autoload?.['psr-4'];
  if (!psr4 || typeof psr4 !== 'object') return out;
  for (const [prefix, target] of Object.entries(psr4)) {
    const targets = Array.isArray(target) ? target : [target];
    // Normalize each dir to posix, strip leading `./`, strip trailing `/`
    const normalized = targets
      .filter(t => typeof t === 'string')
      .map(t => toPosix(t).replace(/\/$/, ''));
    // Ensure non-empty prefixes end with a backslash so the
    // longest-prefix-match does not accidentally split mid-segment
    // ("App" vs "Application"). Preserve the empty prefix as-is — it's
    // Composer's fallback mapping (`"psr-4": {"": "src/"}`) and means
    // "any namespace resolves under this dir". Appending `\` would
    // convert it into a prefix that matches nothing.
    const normalizedPrefix = prefix === '' || prefix.endsWith('\\') ? prefix : prefix + '\\';
    out.set(normalizedPrefix, normalized);
  }
  return out;
}

/**
 * Load every `composer.json` discovered in the input file list and parse
 * each's `autoload.psr-4` section. Returns Map<dirPath, autoloadMap>
 * keyed by the project-relative POSIX directory containing the
 * composer.json (empty string for a root-level composer.json).
 *
 * WHY plural: Composer monorepos commonly stack a root composer.json over
 * per-package composer.json files (one of the two formal "monorepo"
 * patterns Composer documents — `wikimedia/composer-merge-plugin` and
 * `symplify/monorepo-builder` both ship this layout). Loading only the
 * root would miss package-scoped PSR-4 entries entirely.
 *
 * On parse failure for a specific composer.json, emits a Warning: pointing
 * at the bad file and skips it. The rest of the project's PHP imports keep
 * resolving via whichever composer.json files parsed cleanly.
 */
async function loadPhpAutoloads(projectRoot, files) {
  const out = new Map();
  const warnings = [];
  const failures = [];
  const candidates = [];
  for (const f of files) {
    const p = toPosix(f.path);
    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base !== 'composer.json') continue;
    const absPath = join(projectRoot, p);
    if (!existsSync(absPath)) continue;
    candidates.push({ key: p, absPath });
  }
  const reads = await readFilesParallel(candidates);
  for (const { key: p, raw, err } of reads) {
    if (err) {
      failures.push({ path: p, stage: 'resolver-config-read', message: err.message });
      warnings.push(
        `Warning: extract-import-map: composer.json at ${join(projectRoot, p)} failed ` +
        `to read (${err.message}) — PSR-4 namespace mapping from this ` +
        `composer.json unavailable — PHP imports under this package ` +
        `will not resolve\n`,
      );
      continue;
    }
    const parsed = parseComposerAutoloadText(raw);
    if (parsed === null) {
      failures.push({
        path: p,
        stage: 'resolver-config-parse',
        message: 'invalid composer.json',
      });
      warnings.push(
        `Warning: extract-import-map: composer.json at ${join(projectRoot, p)} failed ` +
        `to parse — PSR-4 namespace mapping unavailable — PHP imports ` +
        `under this package will not resolve\n`,
      );
      continue;
    }
    out.set(dirOf(p), parsed);
  }
  return { autoloads: out, warnings, failures };
}

/**
 * Resolve a PHP `use` FQN against the autoload map of the importer's
 * nearest enclosing composer.json. Returns array (0 or 1 match — the first
 * dir in the PSR-4 target list that contains the file).
 *
 * Resolved paths are anchored at the composer.json's directory, NOT at
 * projectRoot, so a sub-package's `App\Foo\Bar` resolves to
 * `<package-dir>/src/Foo/Bar.php` rather than `<projectRoot>/src/...`.
 * This is what Composer's autoloader actually does on disk.
 */
export function resolvePhpImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  // Strip leading backslash if present (PHP allows `use \Foo\Bar;`)
  const fqn = rawImport.startsWith('\\') ? rawImport.slice(1) : rawImport;
  if (!fqn) return [];

  const importerDir = dirOf(toPosix(file.path));
  const composerDir = findNearestConfigDir(importerDir, ctx.phpAutoloads);
  if (composerDir === undefined) return [];
  const autoload = ctx.phpAutoloads.get(composerDir);
  if (!autoload || autoload.size === 0) return [];

  // Longest-prefix match across this composer.json's autoload entries.
  // Walk the map and pick the entry with the longest matching prefix, so
  // `Foo\Bar` does not match a prefix `F\` if `Foo\` is also present.
  // Use `null` as the sentinel rather than 0-length so the empty PSR-4
  // fallback prefix (`""` → `src/`) can win when nothing more specific
  // matches; otherwise `prefix.length > bestPrefix.length` would always
  // be `0 > 0 = false` for the empty prefix.
  let bestPrefix = null;
  let bestDirs = null;
  for (const [prefix, dirs] of autoload) {
    if (fqn.startsWith(prefix) && (bestPrefix === null || prefix.length > bestPrefix.length)) {
      bestPrefix = prefix;
      bestDirs = dirs;
    }
  }
  if (bestDirs === null) return [];

  // Drop the prefix (it covers the directory), translate `\` to `/`.
  const relative = fqn.slice(bestPrefix.length).replace(/\\/g, '/');
  if (!relative) return [];
  for (const dir of bestDirs) {
    // Anchor at the composer.json's own directory — PSR-4 paths are
    // composer-relative, not project-relative.
    const dirUnderComposer = dir
      ? (composerDir ? `${composerDir}/${dir}` : dir)
      : composerDir;
    const candidate = dirUnderComposer
      ? `${dirUnderComposer}/${relative}.php`
      : `${relative}.php`;
    if (ctx.fileSet.has(candidate)) return [candidate];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rust resolver
//
// Rust's module system is path-based but the import syntax is `use` rather
// than path strings. Tree-sitter emits sources like `crate::a::b::Item`,
// `super::a::Item`, `self::a`, or bare `std::collections::HashMap`. We map
// only those rooted at `crate::` or `super::` — bare paths are external
// crates.
//
// Resolution heuristics:
//   - `crate::a::b::*` -> probe `<crate-root>/a/b.rs`, then
//     `<crate-root>/a/b/mod.rs`. The crate root is `<package-dir>/src/`
//     (Cargo convention).
//   - `super::a::b::*` -> walk up one directory from the importer, then
//     descend; same .rs / mod.rs probes.
//   - `self::a::*` -> like `super::a::*` but without the walk-up.
//
// Rust uses won't always land on a file (an import like `crate::Foo` could
// refer to a struct re-exported through `mod.rs`); we accept that limitation.
//
// We also extract `mod x;` declarations via regex — these declare submodules
// to load and translate directly to `<importer-dir>/x.rs` or
// `<importer-dir>/x/mod.rs`.
// ---------------------------------------------------------------------------

/**
 * Try `<base>.rs` then `<base>/mod.rs` against the file set. Returns the
 * first match or null.
 */
function probeRustModule(base, fileSet) {
  if (!base) return null;
  if (fileSet.has(`${base}.rs`)) return `${base}.rs`;
  if (fileSet.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
  return null;
}

/**
 * Find the "crate root" directory for a Rust importer. By Cargo convention,
 * this is the directory containing `src/lib.rs` or `src/main.rs`. For nested
 * workspaces, walk up from the importer until a `src/` ancestor is found.
 * Returns the path relative to project root, or null if not found.
 *
 * The loop walks every ancestor directory (including the root) and probes
 * `<ancestor>/src/lib.rs` and `<ancestor>/src/main.rs`. We don't need a
 * separate "candidate ends with src" branch — when the importer is itself
 * inside `src/`, the next iteration up reaches the package dir and the
 * `<package>/src/lib.rs` probe catches it.
 */
function findRustCrateSrc(importerDir, fileSet) {
  const parts = importerDir.split('/').filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const ancestor = parts.slice(0, i).join('/');
    const childSrc = ancestor ? `${ancestor}/src` : 'src';
    if (fileSet.has(`${childSrc}/lib.rs`) || fileSet.has(`${childSrc}/main.rs`)) {
      return childSrc;
    }
  }
  return null;
}

export function resolveRustImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = rawImport.trim();
  if (!src) return [];

  const importerDir = dirOf(toPosix(file.path));
  const segments = src.split('::').filter(Boolean);
  if (segments.length === 0) return [];
  const head = segments[0];

  // External crates: anything not rooted at crate/super/self.
  if (head !== 'crate' && head !== 'super' && head !== 'self') return [];

  // Walk segments after the head to a base file path. We probe each
  // successive prefix from longest to shortest so that `crate::a::b::Item`
  // matches `a/b.rs` (with `Item` being a re-export inside) rather than
  // failing because `a/b/Item.rs` doesn't exist.
  let baseDir;
  if (head === 'crate') {
    const crateSrc = findRustCrateSrc(importerDir, ctx.fileSet);
    if (!crateSrc) {
      // Warn once per importer file (a single .rs file can have many
      // `use crate::...` statements; suppress duplicate warnings).
      const importerPath = toPosix(file.path);
      if (!ctx._warnedNoRustCrateRoot.has(importerPath)) {
        ctx._warnedNoRustCrateRoot.add(importerPath);
        process.stderr.write(
          `Warning: extract-import-map: Rust file ${importerPath} has ` +
          `'use crate::' but no crate root (src/lib.rs or src/main.rs) ` +
          `found — crate-relative imports unresolved\n`,
        );
      }
      return [];
    }
    baseDir = crateSrc;
  } else if (head === 'super') {
    // Walk up one directory from the importer
    const parts = importerDir.split('/').filter(Boolean);
    if (parts.length === 0) return [];
    baseDir = parts.slice(0, -1).join('/');
  } else {
    // self::
    baseDir = importerDir;
  }

  const rest = segments.slice(1);
  // Try each prefix length from longest -> shortest. The empty rest case
  // (e.g. bare `use crate;`) is unresolvable.
  for (let i = rest.length; i > 0; i--) {
    const prefix = rest.slice(0, i);
    const base = baseDir
      ? `${baseDir}/${prefix.join('/')}`
      : prefix.join('/');
    const match = probeRustModule(base, ctx.fileSet);
    if (match) return [match];
  }
  return [];
}

/**
 * Regex pass for Rust `mod x;` declarations. These are NOT captured by
 * tree-sitter's import field, but they declare a child module on disk that
 * follows the same `<dir>/x.rs` or `<dir>/x/mod.rs` convention.
 */
const RUST_MOD_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;\s*$/gm;

function extractRustModSources(content) {
  const sources = [];
  let m;
  // Rust uses the same line + block comment syntax as JS/TS, so we can reuse
  // the same stripper. Without this, `// mod fake;` would phantom-register
  // a submodule that doesn't exist on disk.
  const stripped = stripJsLikeComments(content);
  RUST_MOD_RE.lastIndex = 0;
  while ((m = RUST_MOD_RE.exec(stripped)) !== null) {
    // Synthesize as a `self::<name>` source so the regular Rust resolver
    // handles it (probes the importer's directory).
    sources.push(`self::${m[1]}`);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// C / C++ resolver
//
// Tree-sitter's cpp extractor exposes both quoted and angle-bracket includes
// as imports with `source` set to the bare filename (e.g. `foo.h`).
// Quoted includes resolve relative to the importer's directory; angle
// includes look in a system path. We can't tell quoted from angle from
// tree-sitter alone, but the resolution rules overlap enough that probing
// both yields the right answer most of the time:
//   1. <importer-dir>/<source>
//   2. include/<source>
//   3. src/<source>
//   4. <source> (project-root-relative)
//
// We probe in that order and take the first match. Multiple file extensions
// (.h, .hpp, .hxx, .cuh) are NOT auto-appended — #include carries the
// extension explicitly.
// ---------------------------------------------------------------------------

export function resolveCppImport(rawImport, file, ctx) {
  if (!rawImport || typeof rawImport !== 'string') return [];
  const src = toPosix(rawImport.trim());
  if (!src) return [];
  const importerDir = dirOf(toPosix(file.path));

  const candidates = [
    resolveRelative(importerDir, src),
    `include/${src}`,
    `src/${src}`,
    src,
  ];
  for (const c of candidates) {
    if (c && ctx.fileSet.has(c)) return [c];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Languages recognized as "code" for resolver dispatch. Tree-sitter parses
 * these via the corresponding extractor; the dispatcher routes the import
 * source through the matching resolver.
 */
const TS_JS_LANGS = new Set([
  'typescript', 'javascript', 'tsx', 'jsx', 'vue',
]);

/**
 * Dispatch a raw import to the language-specific resolver. Returns an array
 * of resolved project-relative paths (most resolvers produce 0 or 1; Python
 * can produce multiple when a `from pkg import a, b, c` resolves both the
 * package's `__init__.py` and each submodule).
 *
 * Per-resolver contract: never throw, never read disk (read once in main()).
 * Empty array means external/unresolved.
 */
function resolveImport(imp, file, ctx) {
  const lang = file.language;
  const src = imp.source;
  if (TS_JS_LANGS.has(lang)) {
    const out = resolveTsJsImport(src, file, ctx);
    return out ? [out] : [];
  }
  if (lang === 'python') {
    return resolvePythonImport(src, imp.specifiers, file, ctx);
  }
  if (lang === 'go') {
    return resolveGoImport(src, file, ctx);
  }
  if (lang === 'java') {
    return resolveJavaImport(src, file, ctx);
  }
  if (lang === 'kotlin') {
    return resolveKotlinImport(src, file, ctx);
  }
  if (lang === 'scala') {
    return resolveScalaImport(src, imp.specifiers, file, ctx);
  }
  if (lang === 'swift') {
    return resolveSwiftImport(src, file, ctx);
  }
  if (lang === 'php') {
    return resolvePhpImport(src, file, ctx);
  }
  if (lang === 'rust') {
    return resolveRustImport(src, file, ctx);
  }
  if (lang === 'c' || lang === 'cpp') {
    return resolveCppImport(src, file, ctx);
  }
  // Ruby is handled via a dedicated pathway because its tree-sitter
  // extractor flattens require vs require_relative into a single field,
  // losing the discriminator the resolver needs.
  return [];
}

/**
 * Collect extra raw import sources that tree-sitter doesn't capture. Today
 * this is CommonJS require() literals for JS/TS files. Returns an array of
 * import-source strings to be passed through resolveImport().
 */
function extractExtraImportSources(file, content) {
  if (TS_JS_LANGS.has(file.language)) {
    return extractRequireSources(content);
  }
  if (file.language === 'kotlin') {
    return extractKotlinSources(content);
  }
  if (file.language === 'rust') {
    // `mod x;` declarations aren't in tree-sitter's `imports` field, but they
    // declare submodules on disk that the rust resolver knows how to find.
    return extractRustModSources(content);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const [,, inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node extract-import-map.mjs <input.json> <output.json>\n');
    process.exit(1);
  }

  const inputRaw = readFileSync(inputPath, 'utf-8');
  const input = JSON.parse(inputRaw);
  const { projectRoot, files, analysisPaths } = input;

  if (!projectRoot || !Array.isArray(files)) {
    throw new Error('Invalid input: must contain projectRoot and files array');
  }

  const analysisFiles = selectAnalysisFiles(files, analysisPaths);

  if (analysisFiles.length === 0) {
    const output = {
      scriptCompleted: true,
      stats: { filesScanned: 0, filesWithImports: 0, totalEdges: 0 },
      failures: [],
      importMap: {},
    };
    writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    process.stderr.write(
      'extract-import-map: filesScanned=0 filesWithImports=0 totalEdges=0\n',
    );
    return;
  }

  // Create tree-sitter plugin with all configs that have WASM grammars.
  //
  // WHY graceful init: the most likely real-world failure mode is the WASM
  // loader failing to locate or fetch the grammar binaries (cache eviction,
  // restricted sandboxes, transient FS issues). When that happens, we still
  // want the script to complete — producing an empty importMap for every
  // code file — rather than crashing the whole project-scanner pipeline.
  // The structural graph will lose import edges, but all OTHER analysis
  // (file inventory, exports inferred from filenames, etc.) keeps working.
  let registry = null;
  let treeSitterReady = false;
  const failures = [];
  try {
    const tsConfigs = builtinLanguageConfigs.filter(c => c.treeSitter);
    const tsPlugin = new TreeSitterPlugin(tsConfigs);
    await tsPlugin.init();
    registry = new PluginRegistry();
    registry.register(tsPlugin);
    registerAllParsers(registry);
    treeSitterReady = true;
  } catch (err) {
    failures.push({ path: null, stage: 'tree-sitter-init', message: err.message });
    process.stderr.write(
      `Warning: extract-import-map: tree-sitter init failed ` +
      `(${err.message}) — all importMap entries will be empty — ` +
      `structural graph will have no import edges\n`,
    );
  }

  // Build resolution context (cached configs). The loader pass for the
  // tsconfig/go.mod/composer.json files inside is parallelised — see
  // `buildResolutionContext`.
  const ctx = await buildResolutionContext(projectRoot, files);
  failures.push(...ctx.failures);

  // Python resolves absolute imports against package roots discovered from
  // the FULL inventory (configs + every .py), so narrowed runs agree with
  // full ones.
  if (analysisFiles.some(f => f.fileCategory === 'code' && f.language === 'python')) {
    ctx.python = await buildPythonIndex(projectRoot, files, ctx.fileSet);
    for (const w of ctx.python.warnings) process.stderr.write(w);
    failures.push(...ctx.python.failures);
  }

  // C# resolves through a solution-wide namespace index built from the FULL
  // inventory (a narrowed analysisPaths still needs every declaring file).
  if (
    treeSitterReady &&
    analysisFiles.some(f => f.fileCategory === 'code' && f.language === 'csharp')
  ) {
    ctx.csharpIndex = await buildCSharpIndex(projectRoot, files);
  }

  const importMap = {};
  let filesWithImports = 0;
  let totalEdges = 0;

  for (const file of analysisFiles) {
    const path = toPosix(file.path);

    // Non-code files always get an empty array
    if (file.fileCategory !== 'code') {
      importMap[path] = [];
      continue;
    }

    // Tree-sitter init failed earlier — produce empty importMap entries for
    // every code file and skip the analysis path. The one-time warning was
    // already emitted at startup.
    if (!treeSitterReady) {
      importMap[path] = [];
      continue;
    }

    const absolutePath = join(projectRoot, file.path);

    // Read file content (per-file resilience)
    let content;
    try {
      content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      failures.push({ path, stage: 'file-read', message: err.message });
      process.stderr.write(
        `Warning: extract-import-map: import resolution failed for ${path} ` +
        `(read error: ${err.message}) — importMap[${path}]=[]\n`,
      );
      importMap[path] = [];
      continue;
    }

    // Analyze + resolve
    let resolved;
    try {
      const resolvedSet = new Set();

      // C# resolves against the namespace index (see resolveCSharpFile).
      // Ruby is the only language whose tree-sitter import field doesn't
      // preserve the require vs require_relative discriminator, so the
      // resolver needs the regex-parsed shape directly. All other tree-sitter
      // languages get analyzed once and dispatched normally.
      if (file.language === 'csharp') {
        for (const out of resolveCSharpFile(path, content, ctx.csharpIndex)) {
          if (ctx.fileSet.has(out)) resolvedSet.add(out);
        }
      } else if (file.language === 'python') {
        // Own parser: tree-sitter misses function-local imports and records
        // aliases instead of imported names (see the Python resolver notes).
        for (const imp of parsePythonImports(content)) {
          for (const out of resolvePythonImport(imp.source, imp.specifiers, file, ctx)) {
            if (out && ctx.fileSet.has(out)) resolvedSet.add(out);
          }
        }
      } else if (file.language === 'ruby') {
        for (const imp of parseRubyImports(content)) {
          for (const out of resolveRubyImport(imp, file, ctx)) {
            if (out && ctx.fileSet.has(out)) resolvedSet.add(out);
          }
        }
      } else {
        const analysis = registry.analyzeFile(file.path, content);
        const imports = analysis?.imports ?? [];
        for (const imp of imports) {
          const outs = resolveImport(imp, file, ctx);
          for (const out of outs) {
            if (out && ctx.fileSet.has(out)) {
              resolvedSet.add(out);
            }
          }
        }
        // Supplemental pass for sources tree-sitter doesn't capture (e.g.
        // CJS require() calls, Kotlin imports). Dedup via the same set.
        for (const extra of extractExtraImportSources(file, content)) {
          const outs = resolveImport({ source: extra, specifiers: [] }, file, ctx);
          for (const out of outs) {
            if (out && ctx.fileSet.has(out)) {
              resolvedSet.add(out);
            }
          }
        }
      }
      resolved = [...resolvedSet].sort((a, b) =>
        file.language === 'scala'
          ? compareScalaPackageMembers(a, b)
          : comparePaths(a, b),
      );
    } catch (err) {
      failures.push({ path, stage: 'file-analyze', message: err.message });
      process.stderr.write(
        `Warning: extract-import-map: import resolution failed for ${path} ` +
        `(analyze error: ${err.message}) — importMap[${path}]=[]\n`,
      );
      importMap[path] = [];
      continue;
    }

    importMap[path] = resolved;
    if (resolved.length > 0) {
      filesWithImports += 1;
      totalEdges += resolved.length;
    }
  }

  const output = {
    scriptCompleted: true,
    stats: {
      filesScanned: analysisFiles.length,
      filesWithImports,
      totalEdges,
    },
    failures,
    importMap,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  if (!existsSync(outputPath)) {
    throw new Error(`output file missing after write: ${outputPath}`);
  }

  process.stderr.write(
    `extract-import-map: filesScanned=${analysisFiles.length} ` +
    `filesWithImports=${filesWithImports} totalEdges=${totalEdges}\n`,
  );
}

// ---------------------------------------------------------------------------
// Run only when executed directly as a CLI; importing the module (e.g. from
// tests) must not trigger main().
//
// Canonicalize both sides through realpathSync. Node ESM resolves
// import.meta.url through symlinks but pathToFileURL(process.argv[1]) preserves
// them, so a raw equality check silently no-ops when the script is invoked via
// a symlinked plugin install path (the default in Claude Code / Copilot CLI
// caches). See GitHub issue #162.
// ---------------------------------------------------------------------------
function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const argvPath = realpathSync(process.argv[1]);
    return modulePath === argvPath;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`extract-import-map.mjs failed: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
}

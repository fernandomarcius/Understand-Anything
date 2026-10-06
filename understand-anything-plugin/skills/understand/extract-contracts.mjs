#!/usr/bin/env node
/**
 * extract-contracts.mjs
 *
 * Deterministic per-member contract extractor for multi-repo workspaces
 * (docs/multi-repo-workspace.md, "Cross-service contracts"). Finds what a
 * member PROVIDES (HTTP routes), what it CONSUMES (outbound HTTP calls), the
 * queues/topics it publishes or subscribes to, the tables it reads or writes,
 * and the URL-like configuration values / services it declares for deploy.
 * No LLM involved: every item carries file + line, and consumers carry a
 * confidence (< 1 whenever any part of the resolution was guessed).
 *
 * Usage:
 *   node extract-contracts.mjs <memberRoot> [--out <file>] [--include-tests]
 *
 * Default output: <memberRoot>/.ua/contracts.json (or the legacy
 * .understand-anything/ data dir when that one already exists).
 *
 * Analysis is lexical (a small tokenizer that understands strings, template
 * literals, interpolations and comments of JS/TS, C# and Python) plus light
 * symbol resolution: same-file declarations, one or more levels of imports
 * inside the member (including tsconfig/jsconfig `baseUrl`/`paths`), helper
 * functions that receive the URL as an argument, wrapper objects
 * (`requests.get(...)`) and typed HttpClients registered with AddHttpClient.
 *
 * Files come from `git ls-files -co --exclude-standard` (recursive walk when
 * git is unavailable), filtered by the core ignore filter (defaults +
 * .understandignore). Test files and docs/ are skipped unless --include-tests.
 *
 * Logging: stderr only.
 */

/* eslint-disable no-control-regex -- \u0000-\u0003 are internal sentinels for dynamic/param segments */

import { createRequire } from 'node:module';
import { dirname, resolve, join, posix, basename, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Optional dependencies (core ignore filter, yaml parser). The script degrades
// gracefully when the plugin's core package is not built.
// ---------------------------------------------------------------------------

let core = null;
try {
  const req = createRequire(resolve(pluginRoot, 'package.json'));
  core = await import(pathToFileURL(req.resolve('@understand-anything/core')).href);
} catch {
  try {
    core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
  } catch {
    core = null;
  }
}

let YAML = null;
for (const base of [resolve(pluginRoot, 'packages/core/package.json'), resolve(pluginRoot, 'package.json')]) {
  try {
    YAML = createRequire(base)('yaml');
    break;
  } catch {
    /* try next */
  }
}

function warn(msg) {
  process.stderr.write(`Warning: extract-contracts: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: null, out: null, includeTests: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--include-tests') args.includeTests = true;
    else if (!args.root) args.root = a;
  }
  return args;
}

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');

function listFiles(root) {
  const res = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status === 0 && typeof res.stdout === 'string') {
    // git ls-files run inside a sub-directory of a repo lists paths relative to cwd.
    return res.stdout.split('\0').filter(Boolean).map(toPosix);
  }
  const out = [];
  const skipDirs = new Set(['.git', 'node_modules', '.ua', '.understand-anything', 'dist', 'build', 'bin', 'obj', '.venv', 'venv', '__pycache__']);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        out.push(toPosix(relative(root, abs)));
      }
    }
  };
  walk(root);
  return out;
}

const TEST_PATH_RE = [
  /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|cypress|testing|fixtures?)\//i,
  /(^|\/)[^/]*[._-](test|spec)s?\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]*\.py$/,
  /(^|\/)[^/]*_test\.(py|go)$/,
  /(^|\/)conftest\.py$/,
  /(^|\/)[A-Za-z0-9_.]*Tests?\//,
];
const NON_CODE_DIRS_RE = /(^|\/)(docs?|\.specify|\.claude|\.github|\.devcontainer|\.vscode|\.idea|node_modules|wwwroot\/lib|migrations?\/versions)\//i;

function isTestPath(p) {
  return TEST_PATH_RE.some((re) => re.test(p));
}

// ---------------------------------------------------------------------------
// Lexing: masked code + string tokens
// ---------------------------------------------------------------------------

/**
 * A lexed file. `code` is `src` with comments blanked and string literal
 * contents blanked (quotes and interpolation EXPRESSIONS are kept, so the
 * masked text stays bracket-balanced and searchable). `strings` maps a token
 * start offset to { start, end, parts: [{lit}|{s,e}] }.
 */
function lineStartsOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const JS_REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const JS_REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function unescapeJs(ch) {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '\0';
    default: return ch;
  }
}

function lexClike(src, lang) {
  const n = src.length;
  const out = src.split('');
  const strings = new Map();
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  // Scan code from i. mode 'top' → to EOF; mode 'expr' → until an unmatched '}' (returns its index).
  function scan(i, mode) {
    let depth = 0;
    let lastSig = '';
    let lastWord = '';
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        const j = src.indexOf('\n', i);
        const end = j < 0 ? n : j;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '/' && d === '*') {
        const j = src.indexOf('*/', i + 2);
        const end = j < 0 ? n : j + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (lang === 'js' && c === '`') {
        i = lexTemplate(i);
        lastSig = '`';
        continue;
      }
      if (lang === 'cs' && (c === '$' || c === '@') && (d === '"' || ((d === '$' || d === '@') && src[i + 2] === '"'))) {
        i = lexCsString(i);
        lastSig = '"';
        continue;
      }
      if (c === '"' || c === "'") {
        if (lang === 'cs' && c === '"' && src.startsWith('"""', i)) {
          i = lexCsRaw(i, i);
        } else {
          i = lexQuoted(i, c);
        }
        lastSig = c;
        continue;
      }
      if (lang === 'js' && c === '/' && (JS_REGEX_PREV.has(lastSig) || JS_REGEX_WORDS.has(lastWord))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        if (j < n && src[j] === '/') {
          blank(i + 1, j);
          i = j + 1;
          while (i < n && /[a-z]/i.test(src[i])) i++;
          lastSig = 'r';
          lastWord = '';
          continue;
        }
      }
      if (mode === 'expr') {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return i;
          depth--;
        }
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        lastWord = src.slice(i, j);
        lastSig = 'a';
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        lastSig = /[0-9]/.test(c) ? 'a' : c;
        lastWord = '';
      }
      i++;
    }
    return n;
  }

  function lexQuoted(i, q) {
    let j = i + 1;
    let lit = '';
    const verbatimCs = false;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\' && !verbatimCs) {
        lit += unescapeJs(src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (ch === q) break;
      if (ch === '\n' && lang !== 'js') break;
      lit += ch;
      j++;
    }
    const end = Math.min(n, j + 1);
    blank(i + 1, j);
    strings.set(i, { start: i, end, parts: [{ lit }] });
    return end;
  }

  function lexTemplate(i) {
    let j = i + 1;
    let lit = '';
    const parts = [];
    let litStart = j;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') {
        lit += unescapeJs(src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (ch === '`') break;
      if (ch === '$' && src[j + 1] === '{') {
        blank(litStart, j + 2);
        if (lit) parts.push({ lit });
        lit = '';
        const s = j + 2;
        const k = scan(s, 'expr');
        parts.push({ s, e: k });
        if (k < n) blank(k, k + 1);
        j = k + 1;
        litStart = j;
        continue;
      }
      lit += ch;
      j++;
    }
    blank(litStart, j);
    if (lit) parts.push({ lit });
    const end = Math.min(n, j + 1);
    strings.set(i, { start: i, end, parts, template: true });
    return end;
  }

  function lexCsRaw(tokStart, i) {
    // """ ... """ (C# 11 raw string, no escapes)
    let q = 0;
    while (src[i + q] === '"') q++;
    const close = '"'.repeat(q);
    const j = src.indexOf(close, i + q);
    const endLit = j < 0 ? n : j;
    const lit = src.slice(i + q, endLit);
    blank(i + q, endLit);
    const end = j < 0 ? n : j + q;
    strings.set(tokStart, { start: tokStart, end, parts: [{ lit }] });
    return end;
  }

  function lexCsString(i) {
    let k = i;
    let interp = false;
    let verbatim = false;
    while (src[k] === '$' || src[k] === '@') {
      if (src[k] === '$') interp = true;
      else verbatim = true;
      k++;
    }
    if (src.startsWith('"""', k)) return lexCsRaw(i, k);
    let j = k + 1;
    let lit = '';
    const parts = [];
    let litStart = j;
    while (j < n) {
      const ch = src[j];
      if (!verbatim && ch === '\\') {
        lit += unescapeJs(src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (ch === '"') {
        if (verbatim && src[j + 1] === '"') {
          lit += '"';
          j += 2;
          continue;
        }
        break;
      }
      if (!verbatim && ch === '\n') break;
      if (interp && ch === '{') {
        if (src[j + 1] === '{') {
          lit += '{';
          j += 2;
          continue;
        }
        blank(litStart, j + 1);
        if (lit) parts.push({ lit });
        lit = '';
        const s = j + 1;
        const close = scan(s, 'expr');
        // format / alignment specifier: first top-level ':' or ','
        let e = close;
        let depth = 0;
        for (let p = s; p < close; p++) {
          const cc = out[p];
          if (cc === '(' || cc === '[' || cc === '{') depth++;
          else if (cc === ')' || cc === ']' || cc === '}') depth--;
          else if (depth === 0 && (cc === ':' || cc === ',') && !(cc === ':' && out[p + 1] === ':')) {
            e = p;
            break;
          }
        }
        if (e < close) blank(e, close);
        parts.push({ s, e });
        if (close < n) blank(close, close + 1);
        j = close + 1;
        litStart = j;
        continue;
      }
      if (interp && ch === '}' && src[j + 1] === '}') {
        lit += '}';
        j += 2;
        continue;
      }
      lit += ch;
      j++;
    }
    blank(litStart, j);
    if (lit) parts.push({ lit });
    const end = Math.min(n, j + 1);
    strings.set(i, { start: i, end, parts, template: interp });
    return end;
  }

  scan(0, 'top');
  return { code: out.join(''), strings };
}

function lexPython(src) {
  const n = src.length;
  const out = src.split('');
  const strings = new Map();
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  function scan(i, mode) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '#') {
        const j = src.indexOf('\n', i);
        const end = j < 0 ? n : j;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        let p = i;
        while (p > 0 && /[rRbBuUfF]/.test(src[p - 1]) && i - p < 2) p--;
        if (p > 0 && /[\w]/.test(src[p - 1])) p = i;
        const prefix = src.slice(p, i).toLowerCase();
        i = lexStr(p, i, prefix);
        continue;
      }
      if (mode === 'expr') {
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === '}') {
          if (depth === 0) return { end: i, stop: i };
          depth--;
        } else if (depth === 0 && c === '!' && src[i + 1] !== '=') {
          return { end: i, stop: findClose(i) };
        } else if (depth === 0 && c === ':' && src[i + 1] !== '=') {
          return { end: i, stop: findClose(i) };
        }
      }
      i++;
    }
    return { end: n, stop: n };
  }

  function findClose(i) {
    let depth = 0;
    for (let k = i; k < n; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') {
        if (depth === 0) return k;
        depth--;
      }
    }
    return n;
  }

  function lexStr(tokStart, i, prefix) {
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    const ql = triple ? 3 : 1;
    const raw = prefix.includes('r');
    const fstr = prefix.includes('f');
    let j = i + ql;
    let lit = '';
    const parts = [];
    let litStart = j;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\' && !raw) {
        lit += unescapeJs(src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (ch === '\\' && raw) {
        lit += ch + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (triple ? src.startsWith(q.repeat(3), j) : ch === q) break;
      if (!triple && ch === '\n') break;
      if (fstr && ch === '{') {
        if (src[j + 1] === '{') {
          lit += '{';
          j += 2;
          continue;
        }
        blank(litStart, j + 1);
        if (lit) parts.push({ lit });
        lit = '';
        const s = j + 1;
        const r = scan(s, 'expr');
        parts.push({ s, e: r.end });
        if (r.end < r.stop) blank(r.end, r.stop);
        if (r.stop < n) blank(r.stop, r.stop + 1);
        j = r.stop + 1;
        litStart = j;
        continue;
      }
      if (fstr && ch === '}' && src[j + 1] === '}') {
        lit += '}';
        j += 2;
        continue;
      }
      lit += ch;
      j++;
    }
    blank(litStart, j);
    if (lit) parts.push({ lit });
    const end = Math.min(n, j + ql);
    const tok = { start: tokStart, end, parts, template: fstr };
    strings.set(tokStart, tok);
    if (tokStart !== i) strings.set(i, tok);
    return end;
  }

  scan(0, 'top');
  return { code: out.join(''), strings };
}

function bracketMap(code) {
  const map = new Map();
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') stack.push(i);
    else if (c === ')' || c === ']' || c === '}') {
      const o = stack.pop();
      if (o !== undefined) {
        map.set(o, i);
        map.set(i, o);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// File context
// ---------------------------------------------------------------------------

const EXT_LANG = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js', '.vue': null,
  '.cs': 'cs',
  '.py': 'py',
};

class Ctx {
  constructor(member, rel, src, lang) {
    this.member = member;
    this.rel = rel;
    this.src = src;
    this.lang = lang;
    const lexed = lang === 'py' ? lexPython(src) : lexClike(src, lang);
    this.code = lexed.code;
    this.strings = lexed.strings;
    this.br = bracketMap(this.code);
    this.lines = lineStartsOf(src);
    this.fns = [];
    this.decls = [];
    this.imports = new Map(); // local name -> { spec, name: 'default'|'*'|exported, file? }
    this.exportsMap = new Map(); // exported name -> local name (or {spec, name} for re-export)
    this.objects = new Map(); // local const name -> object record
    this.calls = [];
  }

  line(off) {
    return lineAt(this.lines, off);
  }

  close(i) {
    return this.br.get(i);
  }
}

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipWs(code, i, end = code.length) {
  while (i < end && isWs(code[i])) i++;
  return i;
}

function skipWsBack(code, i) {
  while (i >= 0 && isWs(code[i])) i--;
  return i;
}

/** Split [s,e) at depth-0 occurrences of `sep` (a single char) in masked code. */
function splitTop(ctx, s, e, sepChar = ',') {
  const out = [];
  let start = s;
  for (let i = s; i < e; i++) {
    const c = ctx.code[i];
    const tk = ctx.strings.get(i);
    if (tk && tk.end > i + 1) {
      i = tk.end - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const j = ctx.close(i);
      if (j !== undefined && j < e) {
        i = j;
        continue;
      }
    }
    if (c === sepChar) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, e]);
  return out
    .map(([a, b]) => trimRange(ctx, a, b))
    .filter(([a, b]) => b > a);
}

function trimRange(ctx, s, e) {
  while (s < e && isWs(ctx.code[s])) s++;
  while (e > s && isWs(ctx.code[e - 1])) e--;
  return [s, e];
}

/** Arguments of a call whose '(' is at `open`. */
function callArgs(ctx, open) {
  const close = ctx.close(open);
  if (close === undefined) return [];
  return splitTop(ctx, open + 1, close, ',');
}

/** Parse `key: value` pairs of an object literal / kwargs list. */
function objectProps(ctx, open) {
  const close = ctx.close(open);
  if (close === undefined) return new Map();
  const props = new Map();
  for (const [a, b] of splitTop(ctx, open + 1, close, ',')) {
    const txt = ctx.code.slice(a, b);
    const tok = ctx.strings.get(a);
    let m;
    if (tok && tok.end <= b) {
      const after = skipWs(ctx.code, tok.end, b);
      if (ctx.code[after] === ':') props.set(literalOf(tok) ?? '', { s: skipWs(ctx.code, after + 1, b), e: b, keyAt: a });
      continue;
    }
    if ((m = /^([A-Za-z_$][\w$]*)\s*:/.exec(txt))) {
      props.set(m[1], { s: skipWs(ctx.code, a + m[0].length, b), e: b, keyAt: a });
    } else if ((m = /^([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(txt)) && ctx.lang !== 'js') {
      props.set(m[1], { s: skipWs(ctx.code, a + m[0].length, b), e: b, keyAt: a });
    } else if ((m = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(txt))) {
      props.set(m[1], { s: a, e: b, method: true, keyAt: a });
    } else if ((m = /^([A-Za-z_$][\w$]*)$/.exec(txt))) {
      props.set(m[1], { s: a, e: b, shorthand: true, keyAt: a });
    }
  }
  return props;
}

function literalOf(tok) {
  if (!tok) return null;
  if (tok.parts.some((p) => p.lit === undefined)) return null;
  return tok.parts.map((p) => p.lit).join('');
}

/** String literal fully occupying [s,e) → its value, else null. */
function stringAt(ctx, s, e) {
  [s, e] = trimRange(ctx, s, e);
  const tok = ctx.strings.get(s);
  if (!tok || tok.end !== e) return null;
  return literalOf(tok);
}

// ---------------------------------------------------------------------------
// Route normalization (shared by providers and consumers)
// ---------------------------------------------------------------------------

const DYN = '\u0000';
const MARK = '\u0001';
const markerOf = (i) => MARK + String.fromCharCode(0x30 + i);
const MARKER_RE = /\u0001([\s\S])/g;

function normalizeRoute(raw, { consumer = false } = {}) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw);
  s = s.replace(MARKER_RE, DYN);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\0]*/i, '');
  s = s.replace(/^~\//, '/');
  // template parameters → {}
  s = s.replace(/\{[^{}]*\}/g, DYN);
  s = s.replace(/<[^<>/]*>/g, DYN);
  s = s.replace(/(^|\/):[A-Za-z_][\w]*\??/g, `$1${DYN}`);
  s = s.replace(/\$\{[^}]*\}/g, DYN);
  // query / fragment
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\\/g, '/');
  if (consumer) {
    // a dynamic tail glued to a literal segment is a query string / suffix builder
    s = s.replace(/([^/\0])\0+$/, '$1');
  }
  s = s.replace(/\0+/g, '{}');
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function normalizeSuffix(s) {
  if (!s) return '';
  const n = normalizeRoute(s);
  return n === '/' ? '' : n;
}

// ---------------------------------------------------------------------------
// Value model for URL evaluation
// ---------------------------------------------------------------------------

const val = (text = '', base = null, suffix = '', conf = 1) => ({ base, suffix, text, conf });
const dyn = (conf = 1) => val(DYN, null, '', conf);
const isEmptyVal = (v) => !v.base && v.text === '';
const hasDyn = (v) => v.text.includes(DYN);

function concat(a, b) {
  if (!a) return b;
  if (!b) return a;
  const conf = Math.min(a.conf, b.conf);
  if (isEmptyVal(a)) return { ...b, conf };
  if (b.base) {
    if (!a.base && a.text === '') return { ...b, conf };
    return { ...a, text: a.text + DYN, conf: conf * 0.9 };
  }
  return { ...a, text: a.text + b.suffix + b.text, conf };
}

/** Module-level constant used as a base: fold its literal tail into `suffix`. */
function asBase(v) {
  if (!v.base) return v;
  if (v.text.includes(MARK)) return v;
  return { ...v, suffix: v.suffix + v.text, text: '' };
}

function envBase(name, conf = 1) {
  return val('', { type: 'env', name, value: null }, '', conf);
}

function configBase(name, conf = 1) {
  return val('', { type: 'config', name, value: null }, '', conf);
}

function chooseAlternative(vals, isFallback) {
  const withBase = vals.filter((v) => v.base);
  if (withBase.length) {
    const first = { ...withBase[0], base: { ...withBase[0].base } };
    if (isFallback) {
      const fb = withBase.slice(1).map((v) => v.base.name || v.base.value).filter(Boolean);
      const uniq = [...new Set(fb)].filter((x) => x !== first.base.name);
      if (uniq.length) first.base.fallbacks = uniq;
    }
    return first;
  }
  const nonEmpty = vals.find((v) => v.text !== '' && v.text !== DYN);
  return nonEmpty || vals[0] || dyn();
}

// ---------------------------------------------------------------------------
// Member: holds every parsed file + cross-file indexes
// ---------------------------------------------------------------------------

class Member {
  constructor(root, files) {
    this.root = root;
    this.files = files; // relative posix paths (all candidate files)
    this.fileSet = new Set(files);
    this.ctxs = new Map();
    this.tsconfigs = null;
    this.csIndex = null;
    this.pyAttrIndex = null;
    this.fnNames = new Set();
    this.helperMemo = new Map();
    this.registrations = null;
  }

  read(rel) {
    try {
      return readFileSync(join(this.root, rel), 'utf-8');
    } catch {
      return null;
    }
  }

  ctx(rel) {
    if (this.ctxs.has(rel)) return this.ctxs.get(rel);
    const lang = EXT_LANG[posix.extname(rel).toLowerCase()];
    let c = null;
    if (lang) {
      const src = this.read(rel);
      if (src !== null && src.length < 2_000_000) {
        try {
          c = new Ctx(this, rel, src, lang);
          indexCtx(c);
        } catch (err) {
          warn(`failed to parse ${rel}: ${err.message}`);
          c = null;
        }
      }
    }
    this.ctxs.set(rel, c);
    return c;
  }
}

// ---------------------------------------------------------------------------
// Per-language indexing: functions, declarations, imports/exports, objects
// ---------------------------------------------------------------------------

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'typeof', 'new', 'await', 'async', 'do', 'else', 'super', 'import', 'export', 'delete', 'void', 'throw', 'yield', 'in', 'of', 'case', 'constructor']);
const CS_KEYWORDS = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new', 'nameof', 'typeof', 'sizeof', 'await', 'when', 'fixed', 'checked', 'unchecked', 'default', 'base', 'this', 'is', 'as', 'throw', 'else', 'do', 'in', 'out', 'ref', 'get', 'set', 'init', 'where', 'select', 'from', 'class', 'struct', 'record', 'interface', 'enum', 'namespace']);

function indexCtx(ctx) {
  if (ctx.lang === 'js') indexJs(ctx);
  else if (ctx.lang === 'cs') indexCs(ctx);
  else if (ctx.lang === 'py') indexPy(ctx);
  for (const f of ctx.fns) if (f.name) ctx.member.fnNames.add(f.name);
  ctx.fns.sort((a, b) => a.bodyS - b.bodyS || b.bodyE - a.bodyE);
}

function parseParams(ctx, s, e) {
  const params = [];
  for (const [a, b] of splitTop(ctx, s, e, ',')) {
    let txt = ctx.code.slice(a, b);
    let defS = null;
    let defE = null;
    // default value (top-level '=')
    let depth = 0;
    for (let k = a; k < b; k++) {
      const c = ctx.code[k];
      if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
      else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
      else if (c === '=' && depth === 0 && ctx.code[k + 1] !== '>' && ctx.code[k - 1] !== '=' && ctx.code[k + 1] !== '=') {
        defS = skipWs(ctx.code, k + 1, b);
        defE = b;
        txt = ctx.code.slice(a, k);
        break;
      }
    }
    txt = txt.replace(/\[[^\]]*\]/g, ' ').trim();
    let name = null;
    if (ctx.lang === 'cs') {
      const m = /([A-Za-z_]\w*)\s*$/.exec(txt);
      name = m ? m[1] : null;
    } else if (ctx.lang === 'py') {
      const m = /^\**([A-Za-z_]\w*)/.exec(txt);
      name = m ? m[1] : null;
    } else {
      const m = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(txt);
      name = m ? m[1] : null;
    }
    params.push({ name, defS, defE });
  }
  return params;
}

/** End of a JS expression starting at s (arrow expression body / declaration RHS). */
function jsExprEnd(ctx, s, limit = ctx.code.length) {
  const code = ctx.code;
  let i = s;
  while (i < limit) {
    const c = code[i];
    const tk = ctx.strings.get(i);
    if (tk && tk.end > i + 1) {
      i = tk.end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const j = ctx.close(i);
      if (j === undefined) return limit;
      i = j + 1;
      continue;
    }
    if (c === ')' || c === ']' || c === '}' || c === ';' || c === ',') return i;
    if (c === '\n') {
      // ASI-ish: stop unless the expression obviously continues
      const prev = code.slice(s, i).replace(/\s+$/, '');
      const last = prev[prev.length - 1];
      const nx = skipWs(code, i, limit);
      const next = code[nx];
      const next2 = code.slice(nx, nx + 2);
      const continues = /[+\-*/%=&|?:.,(<>!^~[{]$/.test(last ?? '') ||
        next === '.' || next === '?' || next === ':' || next === '+' || next === '-' || next === '*' || next === '/' ||
        next2 === '&&' || next2 === '||' || next2 === '??' || next === ')' && false;
      if (!continues) return i;
      i = nx;
      continue;
    }
    i++;
  }
  return limit;
}

function indexJs(ctx) {
  const code = ctx.code;
  let m;
  // --- function declarations
  const fnRe = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
  while ((m = fnRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = ctx.close(open);
    if (close === undefined) continue;
    let b = skipWs(code, close + 1);
    if (code[b] === ':') {
      // TS return type
      while (b < code.length && code[b] !== '{') b++;
    }
    if (code[b] !== '{') continue;
    const bodyE = ctx.close(b);
    if (bodyE === undefined) continue;
    const name = m[1] || jsNameBefore(ctx, m.index);
    ctx.fns.push({ ctx, name, start: m.index, params: parseParams(ctx, open + 1, close), bodyS: b + 1, bodyE, exprBody: false });
  }
  // --- arrow functions
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(code))) {
    const arrow = m.index;
    let p = skipWsBack(code, arrow - 1);
    let paramsS;
    let paramsE;
    let headStart;
    if (code[p] === ')') {
      const o = ctx.close(p);
      if (o === undefined) continue;
      paramsS = o + 1;
      paramsE = p;
      headStart = o;
    } else if (/[\w$]/.test(code[p])) {
      let q = p;
      while (q > 0 && /[\w$]/.test(code[q - 1])) q--;
      // TS return type annotation: `(a): T =>`
      const before = code.slice(Math.max(0, q - 300), q);
      const rt = /\)\s*:\s*[\w$<>[\]\s|,.'"{}?]*$/.exec(before);
      const word = code.slice(q, p + 1);
      if (rt && !/^(async)$/.test(word)) {
        const closeParen = q - before.length + rt.index;
        const o = ctx.close(closeParen);
        if (o === undefined) continue;
        paramsS = o + 1;
        paramsE = closeParen;
        headStart = o;
      } else {
        paramsS = q;
        paramsE = p + 1;
        headStart = q;
      }
    } else if (code[p] === '>' ) {
      const before = code.slice(Math.max(0, p - 300), p + 1);
      const rt = /\)\s*:\s*[\w$<>[\]\s|,.'"{}?]*$/.exec(before);
      if (!rt) continue;
      const closeParen = p + 1 - before.length + rt.index;
      const o = ctx.close(closeParen);
      if (o === undefined) continue;
      paramsS = o + 1;
      paramsE = closeParen;
      headStart = o;
    } else continue;
    let b = skipWs(code, arrow + 2);
    let bodyS;
    let bodyE;
    let exprBody;
    if (code[b] === '{') {
      bodyS = b + 1;
      bodyE = ctx.close(b);
      if (bodyE === undefined) continue;
      exprBody = false;
    } else {
      bodyS = b;
      bodyE = jsExprEnd(ctx, b);
      exprBody = true;
    }
    let hs = headStart;
    const asyncM = /async\s*$/.exec(code.slice(Math.max(0, hs - 10), hs));
    if (asyncM) hs -= asyncM[0].length;
    const name = jsNameBefore(ctx, hs);
    ctx.fns.push({ ctx, name, start: hs, params: parseParams(ctx, paramsS, paramsE), bodyS, bodyE, exprBody });
  }
  // --- method shorthand / class methods
  const methRe = /(^|[\s;{},])(?:(?:async|static|get|set|public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = methRe.exec(code))) {
    const name = m[2];
    if (JS_KEYWORDS.has(name) && name !== 'constructor') continue;
    const open = m.index + m[0].length - 1;
    const close = ctx.close(open);
    if (close === undefined) continue;
    let b = skipWs(code, close + 1);
    if (code[b] === ':') {
      while (b < code.length && code[b] !== '{' && code[b] !== ';' && code[b] !== '\n') b++;
    }
    if (code[b] !== '{') continue;
    // exclude calls followed by a block (`if (x) {` already filtered; `foo(x) {` only valid as a definition)
    const prev = skipWsBack(code, m.index + m[1].length - 1);
    if (code[prev] === '.' ) continue;
    const bodyE = ctx.close(b);
    if (bodyE === undefined) continue;
    const start = m.index + m[1].length;
    if (ctx.fns.some((f) => f.bodyS === b + 1)) continue;
    ctx.fns.push({ ctx, name, start, params: parseParams(ctx, open + 1, close), bodyS: b + 1, bodyE, exprBody: false, method: true });
  }
  // --- declarations
  const declRe = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?![=>])/g;
  while ((m = declRe.exec(code))) {
    const s = skipWs(code, m.index + m[0].length);
    const e = jsExprEnd(ctx, s);
    ctx.decls.push({ name: m[2], at: m.index, s, e, exported: /export\s+$/.test(code.slice(Math.max(0, m.index - 10), m.index)) });
  }
  // bare assignments at statement start (`url = BASE + x` in if/switch branches); chained `a = a = x` folded
  const asgRe = /(?:^|[;{}\n:])[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?![=>])/g;
  while ((m = asgRe.exec(code))) {
    const nameAt = m.index + m[0].indexOf(m[1]);
    if (/\b(const|let|var)\s+$/.test(code.slice(Math.max(0, nameAt - 8), nameAt))) continue;
    let s = skipWs(code, m.index + m[0].length);
    const chained = new RegExp(`^${escRe(m[1])}\\s*=(?![=>])\\s*`).exec(code.slice(s, s + 80));
    if (chained) s += chained[0].length;
    ctx.decls.push({ name: m[1], at: nameAt, s, e: jsExprEnd(ctx, s), assign: true });
  }
  // `for (const x of ARR)` → x evaluates like ARR's first element
  const forOfRe = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g;
  while ((m = forOfRe.exec(code))) {
    const s = m.index + m[0].length;
    const close = code.indexOf(')', s);
    if (close < 0) continue;
    ctx.decls.push({ name: m[1], at: m.index + m[0].indexOf(m[1]), s, e: close, forOf: true });
  }
  // --- imports
  const impRe = /\bimport\s+(type\s+)?([^;'"`]*?)\s*from\s*(?=['"])/g;
  while ((m = impRe.exec(code))) {
    const specAt = m.index + m[0].length;
    const spec = literalOf(ctx.strings.get(specAt));
    if (!spec) continue;
    parseImportClause(ctx, m[2], spec);
  }
  const reqRe = /\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(?=['"])/g;
  while ((m = reqRe.exec(code))) {
    const spec = literalOf(ctx.strings.get(m.index + m[0].length));
    if (!spec) continue;
    const lhs = m[1];
    if (lhs.startsWith('{')) {
      for (const part of lhs.slice(1, -1).split(',')) {
        const [orig, alias] = part.split(':').map((x) => x.trim());
        if (orig) ctx.imports.set(alias || orig, { spec, name: orig });
      }
    } else ctx.imports.set(lhs, { spec, name: 'module.exports' });
  }
  // --- exports
  const expDeclRe = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = expDeclRe.exec(code))) {
    ctx.exportsMap.set(m[1], m[1]);
    if (/export\s+default/.test(m[0])) ctx.exportsMap.set('default', m[1]);
  }
  const expListRe = /\bexport\s*\{([^}]*)\}(\s*from\s*)?/g;
  while ((m = expListRe.exec(code))) {
    const fromSpec = m[2] ? literalOf(ctx.strings.get(m.index + m[0].length)) : null;
    for (const part of m[1].split(',')) {
      const mm = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (!mm) continue;
      if (fromSpec) ctx.exportsMap.set(mm[2] || mm[1], { spec: fromSpec, name: mm[1] });
      else ctx.exportsMap.set(mm[2] || mm[1], mm[1]);
    }
  }
  const expDefRe = /\bexport\s+default\s+/g;
  while ((m = expDefRe.exec(code))) {
    const s = m.index + m[0].length;
    if (/^(async\s+)?(function|class|const|let|var)\b/.test(code.slice(s, s + 20))) continue;
    if (code[s] === '{') {
      ctx.objects.set('#default', objectRecord(ctx, s));
      ctx.exportsMap.set('default', '#default');
    } else {
      const mm = /^([A-Za-z_$][\w$]*)\s*;?/.exec(code.slice(s));
      if (mm) ctx.exportsMap.set('default', mm[1]);
    }
  }
  const modExpRe = /\bmodule\.exports\s*=\s*/g;
  while ((m = modExpRe.exec(code))) {
    const s = m.index + m[0].length;
    if (code[s] === '{') {
      ctx.objects.set('#default', objectRecord(ctx, s));
      ctx.exportsMap.set('module.exports', '#default');
      ctx.exportsMap.set('default', '#default');
    } else {
      const mm = /^([A-Za-z_$][\w$]*)/.exec(code.slice(s));
      if (mm) {
        ctx.exportsMap.set('module.exports', mm[1]);
        ctx.exportsMap.set('default', mm[1]);
      }
    }
  }
  // --- object literals assigned to declarations
  for (const d of ctx.decls) {
    if (code[d.s] === '{') ctx.objects.set(d.name, objectRecord(ctx, d.s));
  }
}

function jsNameBefore(ctx, idx) {
  const before = ctx.code.slice(Math.max(0, idx - 200), idx);
  let m = /([A-Za-z_$][\w$]*)\s*(?::\s*[^=:;{}()]+)?=\s*$/.exec(before);
  if (m) return m[1];
  m = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before);
  if (m) return m[1];
  m = /['"]\s*:\s*$/.exec(before);
  if (m) return null;
  return null;
}

function objectRecord(ctx, open) {
  return { ctx, open, close: ctx.close(open), props: objectProps(ctx, open) };
}

function parseImportClause(ctx, clause, spec) {
  clause = clause.trim();
  if (!clause) return;
  let rest = clause;
  const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(rest);
  if (def) {
    ctx.imports.set(def[1], { spec, name: 'default' });
    rest = rest.slice(def[0].length).trim();
  }
  const ns = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (ns) ctx.imports.set(ns[1], { spec, name: '*' });
  const named = /\{([^}]*)\}/.exec(rest);
  if (named) {
    for (const part of named[1].split(',')) {
      const mm = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (mm) ctx.imports.set(mm[2] || mm[1], { spec, name: mm[1] });
    }
  }
}

function indexCs(ctx) {
  const code = ctx.code;
  let m;
  // --- methods (and constructors)
  const methRe = /\b([A-Za-z_]\w*)\s*(?:<[^<>()=;]*(?:<[^<>()=;]*>[^<>()=;]*)*>)?\s*\(/g;
  while ((m = methRe.exec(code))) {
    const name = m[1];
    if (CS_KEYWORDS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = ctx.close(open);
    if (close === undefined) continue;
    let b = skipWs(code, close + 1);
    if (code.startsWith('where', b)) {
      while (b < code.length && code[b] !== '{' && !code.startsWith('=>', b) && code[b] !== ';') b++;
    }
    let bodyS;
    let bodyE;
    let exprBody;
    if (code[b] === '{') {
      bodyS = b + 1;
      bodyE = ctx.close(b);
      exprBody = false;
    } else if (code.startsWith('=>', b)) {
      bodyS = skipWs(code, b + 2);
      bodyE = code.indexOf(';', bodyS);
      // ensure ';' at depth 0
      let i = bodyS;
      while (i < code.length) {
        const c = code[i];
        const tk = ctx.strings.get(i);
        if (tk && tk.end > i + 1) {
          i = tk.end;
          continue;
        }
        if (c === '(' || c === '[' || c === '{') {
          const j = ctx.close(i);
          if (j === undefined) break;
          i = j + 1;
          continue;
        }
        if (c === ';') break;
        i++;
      }
      bodyE = i;
      exprBody = true;
    } else continue;
    if (bodyE === undefined || bodyE < 0) continue;
    // must be preceded by a type token (definition), not `new`, `.`, `=`, etc.
    const p = skipWsBack(code, m.index - 1);
    const pc = code[p];
    if (!(pc && (/[\w>\]?]/.test(pc)))) continue;
    const prevWord = /([A-Za-z_]\w*)\s*$/.exec(code.slice(Math.max(0, m.index - 40), m.index));
    if (prevWord && ['new', 'return', 'await', 'throw', 'else', 'case', 'in', 'is', 'as', 'using', 'yield', 'class', 'record', 'struct', 'interface'].includes(prevWord[1])) continue;
    ctx.fns.push({ ctx, name, start: m.index, params: parseParams(ctx, open + 1, close), bodyS, bodyE, exprBody });
  }
  // --- declarations / assignments / properties
  const declRe = /(?<![=!<>+\-*/%&|^?:.])\b([A-Za-z_]\w*)\s*=(?![=>])/g;
  while ((m = declRe.exec(code))) {
    const s = skipWs(code, m.index + m[0].length);
    const e = csExprEnd(ctx, s);
    const before = code.slice(Math.max(0, m.index - 80), m.index);
    const isConst = /\bconst\s+[\w<>?,.\s]+$/.test(before);
    const isStaticRo = /\bstatic\s+readonly\s+[\w<>?,.\s]+$/.test(before) || /\breadonly\s+[\w<>?,.\s]+$/.test(before);
    ctx.decls.push({ name: m[1], at: m.index, s, e, isConst, isStaticRo });
  }
  const propRe = /\b([A-Za-z_]\w*)\s*\{\s*(?:(?:public|private|protected|internal)\s+)?(?:get|init|set)\b[^{}]*\}\s*=/g;
  while ((m = propRe.exec(code))) {
    const s = skipWs(code, m.index + m[0].length);
    ctx.decls.push({ name: m[1], at: m.index, s, e: csExprEnd(ctx, s), isProp: true });
  }
  const exprPropRe = /\b(?:public|private|protected|internal|static)\b[^;{}()=]*?\b([A-Za-z_]\w*)\s*=>/g;
  while ((m = exprPropRe.exec(code))) {
    const s = skipWs(code, m.index + m[0].length);
    ctx.decls.push({ name: m[1], at: m.index, s, e: csExprEnd(ctx, s), isProp: true });
  }
  // `x is { } name` / `x is Type name` pattern variables
  const isRe = /\bis\s+(?:\{\s*\}|[A-Za-z_][\w.<>?]*)\s+([A-Za-z_]\w*)\b/g;
  while ((m = isRe.exec(code))) {
    let depth = 0;
    let k = m.index - 1;
    for (; k >= 0; k--) {
      const c = code[k];
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === ';')) break;
    }
    ctx.decls.push({ name: m[1], at: m.index, s: k + 1, e: m.index });
  }
  // --- classes
  ctx.classes = [];
  const clsRe = /\b(class|record|struct|interface)\s+([A-Za-z_]\w*)/g;
  while ((m = clsRe.exec(code))) {
    let b = m.index + m[0].length;
    // primary constructor / generics / base list
    while (b < code.length && code[b] !== '{' && code[b] !== ';') {
      if (code[b] === '(') {
        const j = ctx.close(b);
        if (j === undefined) break;
        b = j + 1;
        continue;
      }
      b++;
    }
    if (code[b] !== '{') continue;
    const header = code.slice(m.index, b);
    let primaryParams = [];
    const pp = /\(/.exec(header.slice(m[0].length));
    if (pp && /^\s*(<[^>]*>)?\s*$/.test(header.slice(m[0].length, m[0].length + pp.index))) {
      const open = m.index + m[0].length + pp.index;
      const close = ctx.close(open);
      if (close !== undefined) primaryParams = parseParams(ctx, open + 1, close);
    }
    ctx.classes.push({ kind: m[1], name: m[2], start: m.index, header, bodyS: b + 1, bodyE: ctx.close(b), primaryParams });
  }
  const nsM = /\bnamespace\s+([\w.]+)/.exec(code);
  ctx.namespace = nsM ? nsM[1] : '';
}

function csExprEnd(ctx, s) {
  const code = ctx.code;
  let i = s;
  while (i < code.length) {
    const c = code[i];
    const tk = ctx.strings.get(i);
    if (tk && tk.end > i + 1) {
      i = tk.end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const j = ctx.close(i);
      if (j === undefined) return code.length;
      i = j + 1;
      continue;
    }
    if (c === ';' || c === ',' || c === ')' || c === ']' || c === '}') return i;
    i++;
  }
  return i;
}

function pyLogicalEnd(ctx, s) {
  const code = ctx.code;
  let i = s;
  while (i < code.length) {
    const c = code[i];
    const tk = ctx.strings.get(i);
    if (tk && tk.end > i + 1) {
      i = tk.end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const j = ctx.close(i);
      if (j === undefined) return code.length;
      i = j + 1;
      continue;
    }
    if (c === '\\' && code[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n' || c === ';') return i;
    i++;
  }
  return i;
}

function indentOf(code, lineStart) {
  let i = lineStart;
  while (code[i] === ' ' || code[i] === '\t') i++;
  return i - lineStart;
}

function indexPy(ctx) {
  const code = ctx.code;
  let m;
  const defRe = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)\s*\(/gm;
  while ((m = defRe.exec(code))) {
    const indent = m[1].length;
    const open = m.index + m[0].length - 1;
    const close = ctx.close(open);
    if (close === undefined) continue;
    const colon = code.indexOf(':', close);
    if (colon < 0) continue;
    // body: lines after the def with indentation > def indentation
    let bodyS = colon + 1;
    let i = code.indexOf('\n', colon);
    let bodyE = code.length;
    if (i < 0) bodyE = code.length;
    else {
      const restOnLine = code.slice(colon + 1, i).trim();
      if (restOnLine) {
        bodyE = i; // one-liner `def f(): return x`
      } else {
        let lineStart = i + 1;
        bodyE = code.length;
        while (lineStart < code.length) {
          const nl = code.indexOf('\n', lineStart);
          const lineEnd = nl < 0 ? code.length : nl;
          const txt = code.slice(lineStart, lineEnd);
          if (txt.trim() !== '') {
            if (indentOf(code, lineStart) <= indent) {
              bodyE = lineStart - 1;
              break;
            }
          }
          if (nl < 0) break;
          lineStart = nl + 1;
        }
      }
    }
    let params = parseParams(ctx, open + 1, close);
    const isMethod = params[0] && (params[0].name === 'self' || params[0].name === 'cls');
    if (isMethod) params = params.slice(1);
    ctx.fns.push({ ctx, name: m[2], start: m.index + m[1].length, params, bodyS, bodyE, exprBody: false, isMethod });
  }
  const declRe = /^[ \t]*((?:self\.)?[A-Za-z_]\w*)\s*(?::\s*[^=\n]+)?=(?!=)/gm;
  while ((m = declRe.exec(code))) {
    const s = skipWs(code, m.index + m[0].length);
    const e = pyLogicalEnd(ctx, s);
    const name = m[1].replace(/^self\./, '');
    ctx.decls.push({ name, at: m.index + (m[0].length - m[0].trimStart().length), s, e, selfAttr: m[1].startsWith('self.') });
  }
  // imports
  const fromRe = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
  while ((m = fromRe.exec(code))) {
    const level = m[1].length;
    const mod = m[2];
    const names = m[3].replace(/[()]/g, '').split(',');
    for (const part of names) {
      const mm = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part.replace(/\\\n/g, ' '));
      if (mm) ctx.imports.set(mm[2] || mm[1], { level, mod, name: mm[1] });
    }
  }
  const impRe = /^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/gm;
  while ((m = impRe.exec(code))) {
    ctx.imports.set(m[2] || m[1].split('.')[0], { level: 0, mod: m[2] ? m[1] : m[1].split('.')[0], name: '*' });
  }
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

function enclosingFns(ctx, off) {
  const out = ctx.fns.filter((f) => f.bodyS <= off && off < f.bodyE);
  out.sort((a, b) => (a.bodyE - a.bodyS) - (b.bodyE - b.bodyS));
  return out;
}

function innermostFn(ctx, off) {
  return enclosingFns(ctx, off)[0] || null;
}

function fnOfDecl(ctx, d) {
  return innermostFn(ctx, d.at);
}

function isModuleLevel(ctx, d) {
  if (ctx.lang === 'cs') return !innermostFn(ctx, d.at);
  return !innermostFn(ctx, d.at);
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

function stripJsonComments(raw) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += raw[++i] ?? '';
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      const j = raw.indexOf('*/', i + 2);
      i = j < 0 ? raw.length : j + 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function loadTsConfigs(member) {
  if (member.tsconfigs) return member.tsconfigs;
  const list = [];
  for (const f of member.files) {
    if (!/(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(f)) continue;
    const raw = member.read(f);
    if (!raw) continue;
    let json;
    try {
      json = JSON.parse(stripJsonComments(raw));
    } catch {
      continue;
    }
    const co = json.compilerOptions || {};
    const dir = posix.dirname(f) === '.' ? '' : posix.dirname(f);
    const baseUrl = co.baseUrl !== undefined ? posix.normalize(posix.join(dir, co.baseUrl)) : null;
    list.push({ dir, baseUrl: baseUrl === '.' ? '' : baseUrl, paths: co.paths || null });
  }
  list.sort((a, b) => b.dir.length - a.dir.length);
  member.tsconfigs = list;
  return list;
}

const JS_EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

function probeJs(member, base) {
  base = posix.normalize(base).replace(/^\.\//, '');
  for (const ext of JS_EXTS) {
    const cand = base + ext;
    if (member.fileSet.has(cand) && EXT_LANG[posix.extname(cand)] === 'js') return cand;
  }
  return null;
}

function resolveJsModule(member, fromRel, spec) {
  if (spec.startsWith('.')) {
    const dir = posix.dirname(fromRel);
    return probeJs(member, posix.join(dir === '.' ? '' : dir, spec));
  }
  const configs = loadTsConfigs(member).filter((c) => c.dir === '' || fromRel.startsWith(c.dir + '/'));
  for (const c of configs) {
    if (c.paths) {
      for (const [pattern, targets] of Object.entries(c.paths)) {
        const star = pattern.indexOf('*');
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        const suffixP = star >= 0 ? pattern.slice(star + 1) : '';
        if (star >= 0 ? spec.startsWith(prefix) && spec.endsWith(suffixP) : spec === pattern) {
          const mid = star >= 0 ? spec.slice(prefix.length, spec.length - suffixP.length) : '';
          for (const t of targets) {
            const r = probeJs(member, posix.join(c.baseUrl ?? c.dir, t.replace('*', mid)));
            if (r) return r;
          }
        }
      }
    }
    if (c.baseUrl !== null && c.baseUrl !== undefined) {
      const r = probeJs(member, posix.join(c.baseUrl, spec));
      if (r) return r;
    }
  }
  // common CRA/Vite fallbacks: `src/` as implicit root, `@/` alias
  if (spec.startsWith('@/')) return probeJs(member, posix.join('src', spec.slice(2)));
  return null;
}

function resolvePyModule(member, fromRel, level, mod) {
  const parts = mod ? mod.split('.') : [];
  const cands = [];
  if (level > 0) {
    let dir = posix.dirname(fromRel);
    for (let k = 1; k < level; k++) dir = posix.dirname(dir);
    const base = posix.join(dir === '.' ? '' : dir, ...parts);
    cands.push(base);
  } else {
    cands.push(parts.join('/'));
  }
  const out = [];
  for (const base of cands) {
    for (const suffix of ['.py', '/__init__.py']) {
      const p = base + suffix;
      if (member.fileSet.has(p)) out.push(p);
    }
  }
  if (out.length) return out[0];
  if (level === 0 && parts.length) {
    const tail = parts.join('/');
    const hits = member.files.filter((f) => f.endsWith('/' + tail + '.py') || f.endsWith('/' + tail + '/__init__.py'));
    hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    if (hits.length) return hits[0];
  }
  return null;
}

/** Resolve an imported local name → { ctx, name } in the target module (JS/Python). */
function resolveImport(ctx, local) {
  const imp = ctx.imports.get(local);
  if (!imp) return null;
  const member = ctx.member;
  if (ctx.lang === 'js') {
    const target = resolveJsModule(member, ctx.rel, imp.spec);
    if (!target) return { external: imp.spec, name: imp.name };
    const tctx = member.ctx(target);
    if (!tctx) return null;
    return { ctx: tctx, name: imp.name };
  }
  if (ctx.lang === 'py') {
    if (imp.name !== '*') {
      // `from pkg import mod` (submodule) or `from mod import name`
      const sub = resolvePyModule(member, ctx.rel, imp.level, imp.mod ? `${imp.mod}.${imp.name}` : imp.name);
      if (sub) {
        const sctx = member.ctx(sub);
        if (sctx) return { ctx: sctx, name: '*' };
      }
    }
    const target = resolvePyModule(member, ctx.rel, imp.level, imp.mod);
    if (!target) return { external: imp.mod, name: imp.name };
    const tctx = member.ctx(target);
    if (!tctx) return null;
    return { ctx: tctx, name: imp.name };
  }
  return null;
}

/** Find what an exported name of a JS module refers to: { ctx, local } */
function resolveExport(ctx, name, depth = 0) {
  if (depth > 6) return null;
  if (ctx.lang === 'py') return { ctx, local: name };
  let ent = ctx.exportsMap.get(name);
  if (ent === undefined && name === 'module.exports') ent = ctx.exportsMap.get('default');
  if (ent === undefined) {
    if (ctx.decls.some((d) => d.name === name) || ctx.fns.some((f) => f.name === name)) return { ctx, local: name };
    return null;
  }
  if (typeof ent === 'string') return { ctx, local: ent };
  const target = resolveJsModule(ctx.member, ctx.rel, ent.spec);
  if (!target) return null;
  const tctx = ctx.member.ctx(target);
  return tctx ? resolveExport(tctx, ent.name, depth + 1) : null;
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

const MAX_DEPTH = 40;

function stripOuter(ctx, s, e) {
  for (;;) {
    [s, e] = trimRange(ctx, s, e);
    const code = ctx.code;
    let changed = false;
    const lead = /^(await|new\s+Uri|yield)\b\s*/.exec(code.slice(s, Math.min(e, s + 20)));
    if (lead && lead[1] !== 'new Uri') {
      s += lead[0].length;
      changed = true;
    }
    if (code[s] === '(' && ctx.close(s) === e - 1) {
      s += 1;
      e -= 1;
      changed = true;
    }
    if (e > s && (code[e - 1] === '!') && ctx.lang !== 'py') {
      e -= 1;
      changed = true;
    }
    const asM = /\s+as\s+[\w$.<>[\]|'" ]+$/.exec(code.slice(s, e));
    if (asM && ctx.lang === 'js') {
      e -= asM[0].length;
      changed = true;
    }
    if (!changed) return [s, e];
  }
}

/** Find depth-0 operator positions in [s,e). */
function topLevelOps(ctx, s, e, test) {
  const code = ctx.code;
  const hits = [];
  for (let i = s; i < e; i++) {
    const c = code[i];
    const tk = ctx.strings.get(i);
    if (tk && tk.end > i + 1) {
      i = tk.end - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const j = ctx.close(i);
      if (j !== undefined && j < e) {
        i = j;
        continue;
      }
    }
    const len = test(code, i, s);
    if (len) {
      hits.push([i, len]);
      i += len - 1;
    }
  }
  return hits;
}

function evalExpr(ctx, s, e, env) {
  env = env || {};
  const depth = (env.depth || 0) + 1;
  if (depth > MAX_DEPTH) return dyn(0.5);
  const sub = { ...env, depth };
  [s, e] = stripOuter(ctx, s, e);
  if (e <= s) return val('');
  const code = ctx.code;
  const lang = ctx.lang;

  // C#: `x ?? throw ...` / `expr switch {...}` → left side
  if (lang === 'cs') {
    const th = /\?\?\s*throw\b/.exec(code.slice(s, e));
    if (th) return evalExpr(ctx, s, s + th.index, sub);
  }

  // Python conditional expression: `a if cond else b`
  if (lang === 'py') {
    const ifs = topLevelOps(ctx, s, e, (c, i) => (/\sif\s/.test(c.slice(i - 1, i + 3)) && c.slice(i, i + 2) === 'if' ? 2 : 0));
    if (ifs.length) {
      const elseHits = topLevelOps(ctx, ifs[0][0], e, (c, i) => (c.slice(i, i + 4) === 'else' && /\s/.test(c[i - 1]) && /\s/.test(c[i + 4] ?? ' ') ? 4 : 0));
      const a = evalExpr(ctx, s, ifs[0][0], sub);
      const b = elseHits.length ? evalExpr(ctx, elseHits[0][0] + 4, e, sub) : val('');
      return pickTernary(a, b);
    }
    const ors = topLevelOps(ctx, s, e, (c, i) => (c.slice(i, i + 2) === 'or' && /\s/.test(c[i - 1] ?? '') && /\s/.test(c[i + 2] ?? '') ? 2 : 0));
    if (ors.length) {
      const pieces = [];
      let start = s;
      for (const [i, len] of ors) {
        pieces.push(evalExpr(ctx, start, i, sub));
        start = i + len;
      }
      pieces.push(evalExpr(ctx, start, e, sub));
      return chooseAlternative(pieces, true);
    }
  } else {
    // ternary a ? b : c (skip ?. and ??)
    const q = topLevelOps(ctx, s, e, (c, i) => (c[i] === '?' && c[i + 1] !== '.' && c[i + 1] !== '?' && c[i - 1] !== '?' && !(lang === 'cs' && /[\w>\]]/.test(c[i - 1] ?? '') && /[\s]/.test(c[i + 1] ?? '') && false) ? 1 : 0));
    if (q.length) {
      const qi = q[0][0];
      // matching ':' at depth 0 after qi (account nested ternaries)
      let nest = 0;
      let colon = -1;
      for (const [i] of topLevelOps(ctx, qi + 1, e, (c, k) => ((c[k] === '?' && c[k + 1] !== '.' && c[k + 1] !== '?' && c[k - 1] !== '?') || (c[k] === ':' && c[k + 1] !== ':' && c[k - 1] !== ':') ? 1 : 0))) {
        if (code[i] === '?') nest++;
        else if (nest === 0) {
          colon = i;
          break;
        } else nest--;
      }
      if (colon > 0) {
        const a = evalExpr(ctx, qi + 1, colon, sub);
        const b = evalExpr(ctx, colon + 1, e, sub);
        return pickTernary(a, b);
      }
    }
    const ors = topLevelOps(ctx, s, e, (c, i) => (c.slice(i, i + 2) === '||' || c.slice(i, i + 2) === '??' ? 2 : 0));
    if (ors.length) {
      const pieces = [];
      let start = s;
      for (const [i, len] of ors) {
        pieces.push(evalExpr(ctx, start, i, sub));
        start = i + len;
      }
      pieces.push(evalExpr(ctx, start, e, sub));
      return chooseAlternative(pieces, true);
    }
  }

  // concatenation
  const plus = topLevelOps(ctx, s, e, (c, i, st) => {
    if (c[i] !== '+' || c[i + 1] === '+' || c[i - 1] === '+' || c[i + 1] === '=') return 0;
    const p = skipWsBack(c, i - 1);
    if (p < st) return 0;
    return 1;
  });
  if (plus.length) {
    let acc = null;
    let start = s;
    for (const [i] of plus) {
      acc = concat(acc, evalExpr(ctx, start, i, sub));
      start = i + 1;
    }
    return concat(acc, evalExpr(ctx, start, e, sub));
  }
  // Python `"..." % args`
  if (lang === 'py') {
    const pct = topLevelOps(ctx, s, e, (c, i) => (c[i] === '%' && c[i + 1] !== '=' ? 1 : 0));
    if (pct.length === 1) {
      const fmt = stringAt(ctx, s, pct[0][0]);
      if (fmt !== null) {
        let [a, b] = trimRange(ctx, pct[0][0] + 1, e);
        let args = [[a, b]];
        if (code[a] === '(' && ctx.close(a) === b - 1) args = splitTop(ctx, a + 1, b - 1, ',');
        let k = 0;
        let acc = val('');
        const pieces = fmt.split(/%[sdrf]/);
        pieces.forEach((piece, idx) => {
          acc = concat(acc, val(piece));
          if (idx < pieces.length - 1) {
            const r = args[k++];
            acc = concat(acc, r ? evalExpr(ctx, r[0], r[1], sub) : dyn());
          }
        });
        return acc;
      }
    }
  }
  return evalTerm(ctx, s, e, sub);
}

function pickTernary(a, b) {
  const score = (v) => (v.base ? 4 : 0) + (v.text && v.text !== DYN ? 2 : 0) + (v.text === '' && !v.base ? -1 : 0);
  if (a.base && b.base && a.base.type === b.base.type && a.base.name === b.base.name) return { ...a, conf: Math.min(a.conf, 0.8) };
  const best = score(b) > score(a) ? b : a;
  return { ...best, conf: Math.min(best.conf, 0.9) };
}

function templateValue(ctx, tok, env) {
  let acc = val('');
  for (const p of tok.parts) {
    if (p.lit !== undefined) acc = concat(acc, val(p.lit));
    else acc = concat(acc, evalExpr(ctx, p.s, p.e, env));
  }
  return acc;
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

function evalTerm(ctx, s, e, env) {
  const code = ctx.code;
  const lang = ctx.lang;
  const text = code.slice(s, e);

  // string / template literal
  const tok = ctx.strings.get(s);
  if (tok && tok.end === e) {
    return tok.template ? templateValue(ctx, tok, env) : val(literalOf(tok));
  }
  // string followed by .format(...) / method chain
  if (tok && tok.end < e) {
    const rest = code.slice(tok.end, e);
    const fm = /^\s*\.\s*format\s*\(/.exec(rest);
    if (fm && lang === 'py') {
      const open = tok.end + fm[0].length - 1;
      return pyFormat(ctx, literalOf(tok) ?? '', open, env);
    }
    if (/^\s*\.\s*(trim|strip|rstrip|lstrip|replace|TrimEnd|TrimStart|Trim|toString|ToString)\b/.test(rest)) {
      return tok.template ? templateValue(ctx, tok, env) : val(literalOf(tok));
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return val(text);
  if ((code[s] === '[' || (lang === 'py' && code[s] === '(')) && ctx.close(s) === e - 1) {
    // array / tuple literal: first element (call sites that loop over URL lists)
    const items = splitTop(ctx, s + 1, e - 1, ',');
    return items.length ? { ...evalExpr(ctx, items[0][0], items[0][1], env), conf: 0.7 } : val('');
  }
  if (/^(null|undefined|None|nil|default)$/.test(text)) return val('');
  if (/^(true|false|True|False)$/.test(text)) return dyn();

  // env access
  let m;
  if ((m = /^(?:process\.env|import\.meta\.env)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(text))) return envBase(m[1]);
  if ((m = /^process\.env\s*\[\s*$/.exec(code.slice(s, s + 12)))) {
    /* fallthrough */
  }
  if (lang === 'js' && /^(?:process\.env|import\.meta\.env)\s*\[/.test(text)) {
    const open = s + text.indexOf('[');
    const k = stringAt(ctx, open + 1, ctx.close(open) ?? e);
    if (k) return envBase(k);
  }
  if (lang === 'cs') {
    if ((m = /^(?:System\.)?Environment\s*\.\s*GetEnvironmentVariable\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      const args = callArgs(ctx, open);
      const k = args[0] && stringOrConst(ctx, args[0][0], args[0][1], env);
      if (k) return envBase(k);
    }
    if ((m = /^nameof\s*\(\s*([\w.]+)\s*\)$/.exec(text))) return val(m[1].split('.').pop());
    // configuration["X"], _config["A:B"]
    if ((m = /^[A-Za-z_][\w.]*\s*\[\s*$/.exec(text.slice(0, text.indexOf('[') + 1))) && text.endsWith(']')) {
      const open = s + text.indexOf('[');
      const k = stringAt(ctx, open + 1, e - 1);
      if (k && /config|configuration|settings|_cfg|cfg/i.test(text.slice(0, text.indexOf('[')))) return configBase(k);
    }
    if ((m = /\.\s*GetValue\s*<[^>]*>\s*\(/.exec(text)) || (m = /\.\s*GetSection\s*\(/.exec(text)) || (m = /\.\s*GetConnectionString\s*\(/.exec(text))) {
      const open = s + m.index + m[0].length - 1;
      const args = callArgs(ctx, open);
      const k = args[0] && stringAt(ctx, args[0][0], args[0][1]);
      if (k) return configBase(k);
    }
    if ((m = /^new\s+Uri\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      const args = callArgs(ctx, open);
      if (args.length === 1) return evalExpr(ctx, args[0][0], args[0][1], env);
      if (args.length >= 2) {
        const base = evalExpr(ctx, args[0][0], args[0][1], env);
        const rel = evalExpr(ctx, args[1][0], args[1][1], env);
        if (rel.base) return rel;
        return concat(base, val('/' + rel.text.replace(/^\/+/, '')));
      }
    }
    if ((m = /^(?:string|String)\s*\.\s*Format\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      const args = callArgs(ctx, open);
      if (args.length) {
        const fmt = stringOrConst(ctx, args[0][0], args[0][1], env);
        if (fmt !== null) return csFormat(ctx, fmt, args.slice(1), env);
      }
    }
    if ((m = /^Uri\s*\.\s*Escape(Data|Uri)String\s*\(/.exec(text))) return dyn();
  }
  if (lang === 'py') {
    if ((m = /^(?:os\s*\.\s*)?(?:getenv|environ\s*\.\s*get)\s*\(/.exec(text)) || (m = /^(?:env|environ|config|settings)\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      const args = callArgs(ctx, open);
      const k = args[0] && stringAt(ctx, args[0][0], args[0][1]);
      if (k) {
        const v = envBase(k);
        const dflt = args[1] && stringAt(ctx, args[1][0], args[1][1]);
        if (dflt) v.base.default = dflt;
        return v;
      }
    }
    if ((m = /^(?:os\s*\.\s*)?environ\s*\[/.exec(text))) {
      const open = s + m[0].length - 1;
      const k = stringAt(ctx, open + 1, ctx.close(open) ?? e);
      if (k) return envBase(k);
    }
    if ((m = /^(?:str|quote|quote_plus|urllib\.parse\.quote)\s*\(/.exec(text))) {
      const open = s + m[0].length - 1;
      if (m[0].startsWith('str')) {
        const args = callArgs(ctx, open);
        return args[0] ? evalExpr(ctx, args[0][0], args[0][1], env) : val('');
      }
      return dyn();
    }
  }
  if (lang === 'js') {
    if ((m = /^(?:encodeURIComponent|encodeURI|Number|parseInt|JSON\s*\.\s*stringify)\s*\(/.exec(text))) return dyn();
    if ((m = /^String\s*\(/.exec(text))) {
      const args = callArgs(ctx, s + m[0].length - 1);
      return args[0] ? evalExpr(ctx, args[0][0], args[0][1], env) : val('');
    }
    if ((m = /^new\s+URL\s*\(/.exec(text))) {
      const args = callArgs(ctx, s + m[0].length - 1);
      if (args.length === 1) return evalExpr(ctx, args[0][0], args[0][1], env);
      if (args.length >= 2) {
        const rel = evalExpr(ctx, args[0][0], args[0][1], env);
        const base = evalExpr(ctx, args[1][0], args[1][1], env);
        if (rel.base) return rel;
        return concat(base, val('/' + rel.text.replace(/^\/+/, '')));
      }
    }
    if (/^new\s+URLSearchParams\b/.test(text)) return dyn();
  }

  // trailing call / member chain: split head and the last segment
  const chain = parseChain(ctx, s, e);
  if (!chain) return dyn(0.9);
  return evalChain(ctx, chain, env);
}

function stringOrConst(ctx, s, e, env) {
  const lit = stringAt(ctx, s, e);
  if (lit !== null) return lit;
  const v = evalExpr(ctx, s, e, env);
  if (!v.base && !hasDyn(v) && !v.text.includes(MARK)) return v.text;
  return null;
}

function pyFormat(ctx, fmt, open, env) {
  const args = callArgs(ctx, open);
  const positional = [];
  const named = new Map();
  for (const [a, b] of args) {
    const mm = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(ctx.code.slice(a, b));
    if (mm) named.set(mm[1], [skipWs(ctx.code, a + mm[0].length, b), b]);
    else positional.push([a, b]);
  }
  let acc = val('');
  let auto = 0;
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  let mm;
  const lit = fmt.replace(/\{\{/g, '\u0002').replace(/\}\}/g, '\u0003');
  while ((mm = re.exec(lit))) {
    acc = concat(acc, val(lit.slice(last, mm.index).replace(/\u0002/g, '{').replace(/\u0003/g, '}')));
    const key = mm[1].split(/[!:]/)[0].trim();
    let r = null;
    if (key === '') r = positional[auto++];
    else if (/^\d+$/.test(key)) r = positional[Number(key)];
    else r = named.get(key);
    acc = concat(acc, r ? evalExpr(ctx, r[0], r[1], env) : dyn());
    last = mm.index + mm[0].length;
  }
  return concat(acc, val(lit.slice(last).replace(/\u0002/g, '{').replace(/\u0003/g, '}')));
}

function csFormat(ctx, fmt, args, env) {
  let acc = val('');
  const re = /\{(\d+)(?:[,:][^}]*)?\}/g;
  let last = 0;
  let mm;
  while ((mm = re.exec(fmt))) {
    acc = concat(acc, val(fmt.slice(last, mm.index)));
    const r = args[Number(mm[1])];
    acc = concat(acc, r ? evalExpr(ctx, r[0], r[1], env) : dyn());
    last = mm.index + mm[0].length;
  }
  return concat(acc, val(fmt.slice(last)));
}

/**
 * Parse `a.b(c).d[e]` into segments: [{name, s, e, call: [open, close] | null}].
 * Returns null when the expression is not a plain chain.
 */
function parseChain(ctx, s, e) {
  const code = ctx.code;
  const segs = [];
  let i = s;
  let isNew = false;
  const newM = /^new\s+/.exec(code.slice(s, s + 8));
  if (newM) {
    i += newM[0].length;
    isNew = true;
  }
  while (i < e) {
    i = skipWs(code, i, e);
    if (code[i] === '(' && !segs.length && !isNew) {
      const j = ctx.close(i);
      if (j === undefined || j >= e) return null;
      segs.push({ name: null, paren: [i + 1, j], s: i, e: j + 1, call: null });
      i = j + 1;
      continue;
    }
    if (code[i] === '(' && segs.length) {
      const j = ctx.close(i);
      if (j === undefined || j >= e) return null;
      segs[segs.length - 1].call = [i, j];
      i = j + 1;
      continue;
    }
    if (code[i] === '[' && segs.length) {
      const j = ctx.close(i);
      if (j === undefined || j >= e) return null;
      segs.push({ name: null, index: [i + 1, j], s: i, e: j + 1, call: null });
      i = j + 1;
      continue;
    }
    if (code[i] === '<' && segs.length && ctx.lang !== 'py') {
      // generic arguments `GetValue<string>(`
      const close = code.indexOf('>', i);
      if (close > 0 && close < e && /^<[\w<>,.?\s[\]]*>$/.test(code.slice(i, close + 1))) {
        i = close + 1;
        continue;
      }
      return null;
    }
    if (code[i] === '.' || (code[i] === '?' && code[i + 1] === '.')) {
      i += code[i] === '?' ? 2 : 1;
      continue;
    }
    if (code[i] === '!' && ctx.lang !== 'py') {
      i++;
      continue;
    }
    const mm = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, e));
    if (!mm) return null;
    segs.push({ name: mm[0], s: i, e: i + mm[0].length, call: null });
    i += mm[0].length;
  }
  if (!segs.length) return null;
  return { segs, isNew };
}

const TRANSFORM_METHODS = new Set(['removesuffix', 'removeprefix', 'trim', 'trimEnd', 'trimStart', 'replace', 'replaceAll', 'toString', 'valueOf', 'toLowerCase', 'toUpperCase', 'strip', 'rstrip', 'lstrip', 'TrimEnd', 'TrimStart', 'Trim', 'ToString', 'ToLowerInvariant', 'ToLower', 'rstrip', 'normalize']);

function evalChain(ctx, chain, env) {
  const { segs } = chain;
  const last = segs[segs.length - 1];
  // method transforms on a value: x.trim(), x.replace(...)
  if (segs.length > 1 && last.call && TRANSFORM_METHODS.has(last.name)) {
    const head = { segs: segs.slice(0, -1), isNew: chain.isNew };
    const inner = evalChainOrExpr(ctx, head, env);
    return inner;
  }
  if (segs.length > 1 && last.call && last.name === 'concat') {
    const head = evalChainOrExpr(ctx, { segs: segs.slice(0, -1) }, env);
    let acc = head;
    for (const [a, b] of callArgs(ctx, last.call[0])) acc = concat(acc, evalExpr(ctx, a, b, env));
    return acc;
  }
  if (segs.length > 1 && last.call && (last.name === 'join' || last.name === 'Join' || last.name === 'format' && ctx.lang !== 'py')) {
    return dyn();
  }
  // env-like getter on an unknown receiver: env.get("CFLOW_URL"), ler("CFLOW_API"), PorDestino("CODEQ_URL")
  if (last.call) {
    const fn = resolveCallee(ctx, segs, env);
    if (fn && fn.kind === 'fn') {
      const r = evalFnCall(ctx, fn.fn, last.call, env);
      if (r) return r;
    }
    const args = callArgs(ctx, last.call[0]);
    // any argument carrying a base (normalizers, wrappers)
    let viaArg = null;
    for (const [a, b] of args) {
      const v = evalExpr(ctx, a, b, env);
      if (v.base) {
        viaArg = { ...v, conf: Math.min(v.conf, 0.8) };
        break;
      }
    }
    if (viaArg) return viaArg;
    if (args.length >= 1) {
      const lit = stringAt(ctx, args[0][0], args[0][1]);
      if (lit && ENV_NAME_RE.test(lit) && !/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(lit)) return envBase(lit, 0.7);
    }
    return dyn(0.9);
  }
  // plain identifier / member access
  return evalRef(ctx, segs, env);
}

function evalChainOrExpr(ctx, chain, env) {
  const segs = chain.segs;
  if (segs.length === 1 && segs[0].paren) return evalExpr(ctx, segs[0].paren[0], segs[0].paren[1], env);
  const last = segs[segs.length - 1];
  if (segs.length === 1 && !last.call) return evalRef(ctx, segs, env);
  return evalChain(ctx, chain, env);
}

/** Bind call arguments to fn params and evaluate its return expression. */
function evalFnCall(ctx, fn, call, env) {
  const depth = env.depth || 0;
  if (depth > MAX_DEPTH) return null;
  const key = `${fn.ctx.rel}:${fn.start}`;
  const visiting = env.visiting || new Set();
  if (visiting.has(key)) return null;
  const args = callArgs(ctx, call[0]);
  const bind = new Map();
  fn.params.forEach((p, idx) => {
    if (!p.name) return;
    const a = args[idx];
    if (a) bind.set(p.name, evalExpr(ctx, a[0], a[1], env));
    else if (p.defS !== null) bind.set(p.name, evalExpr(fn.ctx, p.defS, p.defE, { depth: depth + 1, visiting }));
    else bind.set(p.name, val(''));
  });
  const rets = returnExprs(fn);
  if (!rets.length) return null;
  const nv = new Set(visiting);
  nv.add(key);
  const r = rets[rets.length - 1];
  const v = evalExpr(fn.ctx, r[0], r[1], { depth: depth + 1, visiting: nv, bindFn: fn, bind });
  if (v.base || (v.text !== '' && v.text !== DYN)) return v;
  return null;
}

function returnExprs(fn) {
  const ctx = fn.ctx;
  if (fn.exprBody) return [[fn.bodyS, fn.bodyE]];
  if (fn._rets) return fn._rets;
  const out = [];
  const re = /\breturn\b/g;
  re.lastIndex = fn.bodyS;
  let m;
  while ((m = re.exec(ctx.code)) && m.index < fn.bodyE) {
    if (innermostFn(ctx, m.index) !== fn) continue;
    const s = skipWs(ctx.code, m.index + 6);
    let e;
    if (ctx.lang === 'py') e = pyLogicalEnd(ctx, s);
    else if (ctx.lang === 'cs') e = csExprEnd(ctx, s);
    else e = jsExprEnd(ctx, s, fn.bodyE);
    if (e > s) out.push([s, e]);
  }
  fn._rets = out;
  return out;
}

function evalRef(ctx, segs, env) {
  const head = segs[0];
  const sym = resolveName(ctx, head.name, head.s, env);
  let cur = sym;
  for (let k = 1; k < segs.length; k++) {
    const seg = segs[k];
    if (!cur) break;
    if (cur.kind === 'value') {
      // attribute of an unknown value
      cur = null;
      break;
    }
    cur = memberOf(cur, seg);
  }
  if (cur && cur.kind === 'value') return cur.value;
  if (cur && cur.kind === 'expr') return cur.ctx === ctx ? evalExpr(ctx, cur.s, cur.e, env) : evalExpr(cur.ctx, cur.s, cur.e, { depth: env.depth, visiting: env.visiting });
  // member-wide attribute / property lookup (C#: o.Prop, Class.Const; Python: self._cfg.url)
  if (segs.length > 1 || (ctx.lang === 'py' && head.name === 'self')) {
    const lastName = segs[segs.length - 1].name;
    if (lastName) {
      const r = lookupMemberAttr(ctx, lastName, segs.length > 1 ? segs[segs.length - 2].name : null, env);
      if (r) return r;
    }
  }
  return dyn(0.9);
}

/**
 * Resolve a bare identifier at offset `at`.
 * Returns {kind:'value', value} | {kind:'expr', ctx, s, e} | {kind:'fn', fn} | {kind:'obj', obj} | {kind:'module', ctx} | null
 */
function resolveName(ctx, name, at, env) {
  if (!name) return null;
  const code = ctx.code;
  // bound params of the function being evaluated
  if (env.bind && env.bindFn && env.bindFn.ctx === ctx && env.bind.has(name)) {
    const inside = env.bindFn.bodyS <= at && at < env.bindFn.bodyE;
    if (inside) {
      // a local declaration in the bound function shadows nothing from params unless declared before `at`
      const local = nearestDecl(ctx, name, at, env.bindFn);
      if (local) return declSym(ctx, local, env);
      return { kind: 'value', value: env.bind.get(name) };
    }
  }
  const chain = enclosingFns(ctx, at);
  for (const fn of chain) {
    const local = nearestDecl(ctx, name, at, fn);
    if (local) return declSym(ctx, local, env);
    const pidx = fn.params.findIndex((p) => p.name === name);
    if (pidx >= 0) {
      if (env.markFn === fn) return { kind: 'value', value: val(markerOf(pidx)) };
      return { kind: 'value', value: dyn() };
    }
  }
  // module / class level
  const top = nearestDecl(ctx, name, at, null) || ctx.decls.find((d) => d.name === name && isModuleLevel(ctx, d));
  if (top) return declSym(ctx, top, env, true);
  const fns = ctx.fns.filter((f) => f.name === name);
  if (fns.length) {
    const own = fns.find((f) => !innermostFn(ctx, f.start)) || fns[0];
    return { kind: 'fn', fn: own };
  }
  if (ctx.objects.has(name)) return { kind: 'obj', obj: ctx.objects.get(name) };
  // imports
  const imp = resolveImport(ctx, name);
  if (imp && imp.ctx) {
    const tctx = imp.ctx;
    if (imp.name === '*') return { kind: 'module', ctx: tctx };
    const ex = resolveExport(tctx, imp.name === 'module.exports' ? 'module.exports' : imp.name);
    if (!ex) return null;
    if (ex.local === '#default') return { kind: 'obj', obj: tctx.objects.get('#default') };
    return resolveTopLevel(tctx, ex.local, env);
  }
  if (imp && imp.external) return { kind: 'external', spec: imp.external, name: imp.name };
  void code;
  return null;
}

function resolveTopLevel(ctx, name, env) {
  const d = ctx.decls.find((x) => x.name === name && isModuleLevel(ctx, x));
  if (d) return declSym(ctx, d, env, true);
  const fns = ctx.fns.filter((f) => f.name === name);
  if (fns.length) return { kind: 'fn', fn: fns.find((f) => !innermostFn(ctx, f.start)) || fns[0] };
  if (ctx.objects.has(name)) return { kind: 'obj', obj: ctx.objects.get(name) };
  const imp = resolveImport(ctx, name);
  if (imp && imp.ctx) {
    if (imp.name === '*') return { kind: 'module', ctx: imp.ctx };
    const ex = resolveExport(imp.ctx, imp.name);
    if (!ex) return null;
    if (ex.local === '#default') return { kind: 'obj', obj: imp.ctx.objects.get('#default') };
    return resolveTopLevel(imp.ctx, ex.local, env);
  }
  return null;
}

function nearestDecl(ctx, name, at, fn) {
  let best = null;
  for (const d of ctx.decls) {
    if (d.name !== name || d.at >= at) continue;
    if (d.s <= at && at <= d.e) continue; // self-reference
    const owner = fnOfDecl(ctx, d);
    if (fn === null ? owner !== null : owner !== fn) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best;
}

function declSym(ctx, d, env, moduleLevel = false) {
  if (ctx.objects.has(d.name) && ctx.objects.get(d.name).open === d.s) return { kind: 'obj', obj: ctx.objects.get(d.name) };
  const fn = ctx.fns.find((f) => f.start >= d.s && f.start <= d.s + 12 && f.name === d.name);
  if (fn) return { kind: 'fn', fn };
  const visiting = env.visiting || new Set();
  const key = `${ctx.rel}:decl:${d.at}`;
  if (visiting.has(key)) return { kind: 'value', value: dyn() };
  const nv = new Set(visiting);
  nv.add(key);
  const v = evalExpr(ctx, d.s, d.e, { ...env, visiting: nv, depth: (env.depth || 0) + 1 });
  const isTop = moduleLevel || isModuleLevel(ctx, d) || (ctx.lang === 'cs' && (d.isConst || d.isStaticRo || d.isProp || isFieldDecl(ctx, d)));
  return { kind: 'value', value: isTop ? asBase(v) : v };
}

function isFieldDecl(ctx, d) {
  return ctx.lang === 'cs' && !innermostFn(ctx, d.at);
}

function memberOf(sym, seg) {
  if (!seg.name) return null;
  if (sym.kind === 'module') return resolveTopLevel(sym.ctx, seg.name, {});
  if (sym.kind === 'obj' && sym.obj) {
    const p = sym.obj.props.get(seg.name);
    if (!p) return null;
    const octx = sym.obj.ctx;
    if (p.shorthand) return resolveName(octx, seg.name, p.s, {}) || resolveTopLevel(octx, seg.name, {});
    const fn = octx.fns.find((f) => f.start >= p.s && f.start <= p.s + 8 && f.bodyE <= p.e + 1);
    if (fn) return { kind: 'fn', fn };
    if (octx.code[p.s] === '{') return { kind: 'obj', obj: objectRecord(octx, p.s) };
    const id = /^[A-Za-z_$][\w$]*$/.exec(octx.code.slice(p.s, p.e).trim());
    if (id) return resolveName(octx, id[0], p.s, {}) || resolveTopLevel(octx, id[0], {});
    return { kind: 'expr', ctx: octx, s: p.s, e: p.e };
  }
  return null;
}

/** Resolve the function a call chain refers to. */
function resolveCallee(ctx, segs, env) {
  const head = segs[0];
  if (ctx.lang === 'py' && (head.name === 'self' || head.name === 'cls') && segs.length === 2) {
    const fns = ctx.fns.filter((f) => f.name === segs[1].name && f.isMethod);
    if (fns.length) return { kind: 'fn', fn: fns[0] };
    return null;
  }
  if (ctx.lang === 'cs') {
    let segsX = segs;
    if (head.name === 'this' || head.name === 'base') segsX = segs.slice(1);
    if (segsX.length === 1) {
      const nargs = segsX[0].call ? callArgs(ctx, segsX[0].call[0]).length : 0;
      const fns = ctx.fns.filter((f) => f.name === segsX[0].name);
      const best = fns.find((f) => f.params.length === nargs) || fns.find((f) => f.params.length >= nargs && f.params.slice(nargs).every((p) => p.defS !== null)) || fns[0];
      return best ? { kind: 'fn', fn: best } : null;
    }
    if (segsX.length === 2) {
      // Static call on another class of the member: Cls.Method(...)
      const idx = csIndex(ctx.member);
      const cls = idx.classes.get(segsX[0].name);
      if (cls) {
        const fns = cls.ctx.fns.filter((f) => f.name === segsX[1].name && f.start > cls.cls.bodyS && f.start < cls.cls.bodyE);
        if (fns.length) return { kind: 'fn', fn: fns[0] };
      }
    }
    return null;
  }
  let sym = resolveName(ctx, head.name, head.s, env || {});
  for (let k = 1; k < segs.length && sym; k++) sym = memberOf(sym, segs[k]);
  return sym && sym.kind === 'fn' ? sym : null;
}

// --- member-wide attribute lookup (C# properties/consts, Python attributes)

function csIndex(member) {
  if (member.csIndex) return member.csIndex;
  const classes = new Map();
  const attrs = new Map();
  for (const f of member.files) {
    if (!f.endsWith('.cs')) continue;
    const c = member.ctx(f);
    if (!c) continue;
    for (const cls of c.classes || []) if (!classes.has(cls.name)) classes.set(cls.name, { ctx: c, cls });
    for (const d of c.decls) {
      if (!attrs.has(d.name)) attrs.set(d.name, []);
      attrs.get(d.name).push({ ctx: c, d });
    }
  }
  member.csIndex = { classes, attrs };
  return member.csIndex;
}

function pyAttrIndex(member) {
  if (member.pyAttrIndex) return member.pyAttrIndex;
  const attrs = new Map();
  for (const f of member.files) {
    if (!f.endsWith('.py')) continue;
    const c = member.ctx(f);
    if (!c) continue;
    for (const d of c.decls) {
      if (!attrs.has(d.name)) attrs.set(d.name, []);
      attrs.get(d.name).push({ ctx: c, d });
    }
  }
  member.pyAttrIndex = attrs;
  return attrs;
}

function lookupMemberAttr(ctx, name, owner, env) {
  const member = ctx.member;
  const visiting = env.visiting || new Set();
  const key = `attr:${name}`;
  if (visiting.has(key)) return null;
  const nv = new Set(visiting);
  nv.add(key);
  let cands = [];
  if (ctx.lang === 'cs') {
    const idx = csIndex(member);
    if (owner && idx.classes.has(owner)) {
      const { ctx: cctx, cls } = idx.classes.get(owner);
      const d = cctx.decls.find((x) => x.name === name && x.at > cls.bodyS && x.at < cls.bodyE);
      if (d) {
        const v = evalExpr(cctx, d.s, d.e, { depth: (env.depth || 0) + 1, visiting: nv });
        return asBase(v);
      }
    }
    cands = idx.attrs.get(name) || [];
  } else if (ctx.lang === 'py') {
    cands = pyAttrIndex(member).get(name) || [];
  } else return null;
  const found = [];
  for (const { ctx: c, d } of cands.slice(0, 40)) {
    const v = evalExpr(c, d.s, d.e, { depth: (env.depth || 0) + 1, visiting: nv });
    if (v.base && (v.base.type === 'env' || v.base.type === 'config')) found.push(v);
  }
  const names = [...new Set(found.map((v) => `${v.base.type}:${v.base.name}`))];
  if (names.length === 1) {
    const v = found[0];
    return { ...asBase(v), conf: Math.min(v.conf, ctx.lang === 'py' ? 0.6 : 0.8) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP call sites
// ---------------------------------------------------------------------------

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

function verbOf(name) {
  const n = String(name).toLowerCase();
  if (n === 'del' || n === 'delete') return 'DELETE';
  const v = n.toUpperCase();
  return HTTP_VERBS.includes(v) ? v : null;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect primitive HTTP calls + candidate helper calls for a file. */
function collectCalls(ctx) {
  if (ctx._callsDone) return ctx.calls;
  ctx._callsDone = true;
  if (ctx.lang === 'js') collectJsCalls(ctx);
  else if (ctx.lang === 'py') collectPyCalls(ctx);
  else if (ctx.lang === 'cs') collectCsCalls(ctx);
  // generic candidate helper calls: IDENT(.IDENT)*(
  const names = ctx.member.fnNames;
  const re = /(?<![\w$.])((?:this\.|self\.|base\.)?[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  const code = ctx.code;
  const primitiveAt = new Set(ctx.calls.map((c) => c.open));
  let m;
  while ((m = re.exec(code))) {
    const calleeTxt = m[1].replace(/\s+/g, '');
    const parts = calleeTxt.split(/\??\./);
    const lastName = parts[parts.length - 1];
    if (!names.has(lastName)) continue;
    const open = m.index + m[0].length - 1;
    if (primitiveAt.has(open)) continue;
    if (ctx.fns.some((f) => f.start === m.index || (f.params && f.start <= m.index && m.index < f.bodyS && !f.exprBody && ctx.lang !== 'py' && f.name === lastName && f.start === m.index))) continue;
    // skip definitions: `def name(`, `function name(`, `name(params) {` (method), C# method decl
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(def|function|class)\s+$/.test(before)) continue;
    if (ctx.fns.some((f) => f.name === lastName && f.start === m.index)) continue;
    if (ctx.lang === 'cs' && ctx.fns.some((f) => f.name === lastName && Math.abs(f.start - m.index) < 2)) continue;
    const segs = parseChain(ctx, m.index, open);
    if (!segs) continue;
    segs.segs[segs.segs.length - 1].call = [open, ctx.close(open)];
    if (segs.segs[segs.segs.length - 1].call[1] === undefined) continue;
    ctx.calls.push({ kind: 'callee', s: m.index, open, chain: segs });
  }
  ctx.calls.sort((a, b) => a.s - b.s);
  return ctx.calls;
}

function importedNamesFrom(ctx, pred) {
  const out = [];
  for (const [local, imp] of ctx.imports) {
    const spec = imp.spec ?? imp.mod;
    if (spec && pred(spec, imp)) out.push(local);
  }
  return out;
}

function collectJsCalls(ctx) {
  const code = ctx.code;
  const sa = importedNamesFrom(ctx, (spec) => spec === 'superagent');
  const ax = importedNamesFrom(ctx, (spec, imp) => spec === 'axios' && (imp.name === 'default' || imp.name === 'module.exports'));
  let m;
  for (const name of sa) {
    const re = new RegExp(`(?<![\\w$.])${escRe(name)}\\s*\\.\\s*(get|post|put|del|delete|patch|head)\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      ctx.calls.push({ kind: 'primitive', via: 'superagent', s: m.index, open, method: verbOf(m[1]), urlArg: 0 });
    }
  }
  // axios instances
  const instances = new Map();
  for (const name of ax) {
    const cre = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escRe(name)}\\s*\\.\\s*create\\s*\\(`, 'g');
    while ((m = cre.exec(code))) {
      const open = m.index + m[0].length - 1;
      const args = callArgs(ctx, open);
      let baseRange = null;
      if (args[0] && code[args[0][0]] === '{') {
        const p = objectProps(ctx, args[0][0]).get('baseURL');
        if (p) baseRange = p.shorthand ? [p.s, p.e] : [p.s, p.e];
      }
      instances.set(m[1], { baseRange, at: m.index });
    }
  }
  for (const name of ax) {
    const re = new RegExp(`(?<![\\w$.])${escRe(name)}\\s*(?:\\.\\s*(get|post|put|delete|patch|head|options|request)\\s*)?\\(`, 'g');
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      if (/create\s*\($/.test(m[0])) continue;
      if (m[1] && m[1] !== 'request') ctx.calls.push({ kind: 'primitive', via: 'axios', s: m.index, open, method: verbOf(m[1]), urlArg: 0 });
      else ctx.calls.push({ kind: 'primitive', via: 'axios', s: m.index, open, config: true });
    }
  }
  for (const [inst, info] of instances) {
    const re = new RegExp(`(?<![\\w$.])${escRe(inst)}\\s*\\.\\s*(get|post|put|delete|patch|head|options)\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      ctx.calls.push({ kind: 'primitive', via: 'axios.create', s: m.index, open, method: verbOf(m[1]), urlArg: 0, baseRange: info.baseRange });
    }
  }
  const fre = /(?<![\w$.])(?:window\.|globalThis\.)?fetch\s*\(/g;
  while ((m = fre.exec(code))) {
    const open = m.index + m[0].length - 1;
    if (ctx.fns.some((f) => f.name === 'fetch' && f.start === m.index)) continue;
    ctx.calls.push({ kind: 'primitive', via: 'fetch', s: m.index, open, urlArg: 0, optionsArg: 1 });
  }
}

function collectPyCalls(ctx) {
  const code = ctx.code;
  const receivers = new Map(); // receiver text -> { via, baseRange }
  const hasRequests = [...ctx.imports.values()].some((i) => i.mod === 'requests' || (i.mod || '').startsWith('requests'));
  const hasHttpx = [...ctx.imports.values()].some((i) => i.mod === 'httpx');
  if (ctx.imports.has('requests')) receivers.set('requests', { via: 'requests' });
  if (ctx.imports.has('httpx')) receivers.set('httpx', { via: 'httpx' });
  let m;
  const asg = /^[ \t]*((?:self\.)?[A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*([^\n]*)/gm;
  while ((m = asg.exec(code))) {
    const rhs = m[2];
    let via = null;
    if (hasRequests && /\brequests\s*\.\s*Session\s*\(|\bSession\s*\(\)/.test(rhs)) via = 'requests';
    else if (hasHttpx && /\bhttpx\s*\.\s*(Async)?Client\s*\(/.test(rhs)) via = 'httpx';
    if (!via) continue;
    let baseRange = null;
    const cm = /\b(?:Async)?Client\s*\(/.exec(rhs);
    if (cm) {
      const open = m.index + m[0].length - m[2].length + cm.index + cm[0].length - 1;
      const kw = callArgs(ctx, open).map(([a, b]) => [a, b, /^base_url\s*=/.exec(code.slice(a, b))]).find((x) => x[2]);
      if (kw) baseRange = [skipWs(code, kw[0] + kw[2][0].length), kw[1]];
    }
    receivers.set(m[1], { via, baseRange });
  }
  const withRe = /\bwith\s+(httpx\s*\.\s*(?:Async)?Client|requests\s*\.\s*Session)\s*\(/g;
  while ((m = withRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = ctx.close(open);
    const asM = /^\s*as\s+([A-Za-z_]\w*)/.exec(code.slice(close + 1));
    if (!asM) continue;
    const kw = callArgs(ctx, open).map(([a, b]) => [a, b, /^base_url\s*=/.exec(code.slice(a, b))]).find((x) => x[2]);
    receivers.set(asM[1], { via: m[1].startsWith('httpx') ? 'httpx' : 'requests', baseRange: kw ? [skipWs(code, kw[0] + kw[2][0].length), kw[1]] : null });
  }
  for (const [recv, info] of receivers) {
    const re = new RegExp(`(?<![\\w.])${escRe(recv).replace(/\\\./g, '\\s*\\.\\s*')}\\s*\\.\\s*(get|post|put|delete|patch|head|options|request)\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      if (m[1] === 'request') ctx.calls.push({ kind: 'primitive', via: info.via, s: m.index, open, methodArg: 0, urlArg: 1, baseRange: info.baseRange });
      else ctx.calls.push({ kind: 'primitive', via: info.via, s: m.index, open, method: verbOf(m[1]), urlArg: 0, urlKw: 'url', baseRange: info.baseRange });
    }
  }
  // urllib: Request(url, data=..., method=...) / urlopen("literal")
  const hasUrllib = [...ctx.imports.values()].some((i) => (i.mod || '').startsWith('urllib'));
  if (hasUrllib) {
    const rq = /(?<![\w.])(?:urllib\s*\.\s*request\s*\.\s*|request\s*\.\s*)?Request\s*\(/g;
    while ((m = rq.exec(code))) {
      const open = m.index + m[0].length - 1;
      const args = callArgs(ctx, open);
      const kwM = args.find(([a, b]) => /^method\s*=/.test(code.slice(a, b)));
      const hasData = args.some(([a, b], i) => /^data\s*=/.test(code.slice(a, b)) || (i === 1 && !/^\w+\s*=/.test(code.slice(a, b))));
      const call = { kind: 'primitive', via: 'urllib', s: m.index, open, urlArg: 0, urlKw: 'url' };
      if (kwM) call.methodRange = [skipWs(code, code.indexOf('=', kwM[0]) + 1), kwM[1]];
      else call.method = hasData ? 'POST' : 'GET';
      ctx.calls.push(call);
    }
    const uo = /(?<![\w.])(?:urllib\s*\.\s*request\s*\.\s*|request\s*\.\s*)?urlopen\s*\(\s*(?=['"f])/g;
    while ((m = uo.exec(code))) {
      const open = code.lastIndexOf('(', m.index + m[0].length);
      ctx.calls.push({ kind: 'primitive', via: 'urllib', s: m.index, open, urlArg: 0, method: 'GET' });
    }
  }
}

const CS_HTTP_METHODS = {
  GetAsync: 'GET', GetStringAsync: 'GET', GetStreamAsync: 'GET', GetByteArrayAsync: 'GET', GetFromJsonAsync: 'GET',
  PostAsync: 'POST', PostAsJsonAsync: 'POST', PutAsync: 'PUT', PutAsJsonAsync: 'PUT', PatchAsync: 'PATCH', PatchAsJsonAsync: 'PATCH',
  DeleteAsync: 'DELETE', DeleteFromJsonAsync: 'DELETE',
};

function csHttpClientNames(ctx) {
  const code = ctx.code;
  const names = new Set();
  let m;
  const typed = /\bHttpClient\??\s+([A-Za-z_]\w*)\b/g;
  while ((m = typed.exec(code))) names.add(m[1]);
  const newRe = /\b([A-Za-z_]\w*)\s*=\s*new\s+HttpClient\b/g;
  while ((m = newRe.exec(code))) names.add(m[1]);
  const factory = /\b([A-Za-z_]\w*)\s*=\s*[\w.]+\s*\.\s*CreateClient\s*\(/g;
  while ((m = factory.exec(code))) names.add(m[1]);
  // aliases: _http = http;
  for (let pass = 0; pass < 2; pass++) {
    const alias = /\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*[;,)]/g;
    while ((m = alias.exec(code))) if (names.has(m[2])) names.add(m[1]);
  }
  return names;
}

function collectCsCalls(ctx) {
  const code = ctx.code;
  const names = csHttpClientNames(ctx);
  let m;
  if (names.size) {
    const alt = [...names].map(escRe).join('|');
    const re = new RegExp(`(?<![\\w.])(?:this\\.)?(${alt})\\s*\\.\\s*(${Object.keys(CS_HTTP_METHODS).join('|')})\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      ctx.calls.push({ kind: 'primitive', via: 'HttpClient', s: m.index, open, method: CS_HTTP_METHODS[m[2]], urlArg: 0, receiver: m[1] });
    }
  }
  const reqRe = /\bnew\b\s*(?:HttpRequestMessage\s*)?\(\s*(?=(?:HttpMethod\s*\.|new\s+HttpMethod\b|[A-Za-z_]\w*\s*,))/g;
  while ((m = reqRe.exec(code))) {
    const open = m.index + m[0].indexOf('(');
    const isExplicit = /HttpRequestMessage/.test(m[0]);
    const args = callArgs(ctx, open);
    if (args.length < 2) continue;
    const first = code.slice(args[0][0], args[0][1]);
    if (!isExplicit && !/^(HttpMethod\s*\.|new\s+HttpMethod)/.test(first)) {
      // target-typed `new(metodo, caminho)`: only when the declared/returned type is HttpRequestMessage
      const before = code.slice(Math.max(0, m.index - 200), m.index);
      if (!/HttpRequestMessage[^;{}]*$/.test(before)) continue;
    }
    ctx.calls.push({ kind: 'primitive', via: 'HttpClient', s: m.index, open, methodArg: 0, urlArg: 1, requestMessage: true });
  }
  const initRe = /\bnew\s+HttpRequestMessage\s*(?:\(\s*\))?\s*\{/g;
  while ((m = initRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const props = objectProps(ctx, open);
    const meth = props.get('Method');
    const uri = props.get('RequestUri');
    if (!uri) continue;
    ctx.calls.push({ kind: 'primitive', via: 'HttpClient', s: m.index, open, methodRange: meth ? [meth.s, meth.e] : null, urlRange: [uri.s, uri.e], requestMessage: true });
  }
}

function methodFromValue(ctx, s, e, env) {
  const txt = ctx.code.slice(s, e).trim();
  let m;
  if ((m = /^HttpMethod\s*\.\s*(\w+)$/.exec(txt))) return { method: verbOf(m[1]) || m[1].toUpperCase() };
  if ((m = /^new\s+HttpMethod\s*\(/.exec(txt))) {
    const args = callArgs(ctx, s + txt.indexOf('('));
    const lit = args[0] && stringAt(ctx, args[0][0], args[0][1]);
    if (lit) return { method: lit.toUpperCase() };
  }
  const lit = stringAt(ctx, s, e);
  if (lit !== null) return { method: verbOf(lit) || lit.toUpperCase() };
  const v = evalExpr(ctx, s, e, env);
  const mk = /\u0001([\s\S])/.exec(v.text);
  if (mk && v.text.length === 2) return { param: mk[1].charCodeAt(0) - 0x30 };
  if (!v.base && v.text && !hasDyn(v) && verbOf(v.text)) return { method: verbOf(v.text) };
  return { method: null };
}

/** Find the argument range for `urlArg` / `url=` kwarg. */
function argRange(ctx, call, idx, kw) {
  const args = callArgs(ctx, call.open);
  if (kw) {
    for (const [a, b] of args) {
      const mm = new RegExp(`^${kw}\\s*=(?!=)`).exec(ctx.code.slice(a, b));
      if (mm) return [skipWs(ctx.code, a + mm[0].length, b), b];
    }
  }
  const positional = ctx.lang === 'py' ? args.filter(([a, b]) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(ctx.code.slice(a, b))) : args;
  return positional[idx] || null;
}

/**
 * Evaluate one call site. Returns null when it is not an HTTP call; otherwise
 * { value, method: {method}|{param}, via, helperVia }.
 */
function analyzeCall(ctx, call, fn) {
  const env = { markFn: fn, depth: 0 };
  if (call.kind === 'primitive') {
    let value = null;
    let method = call.method ? { method: call.method } : null;
    let urlR = call.urlRange || (call.urlArg !== undefined ? argRange(ctx, call, call.urlArg, call.urlKw) : null);
    if (call.config) {
      // axios(config) / axios.request(config) / axios(url, config)
      const args = callArgs(ctx, call.open);
      if (!args.length) return null;
      let cfgR = args[0];
      if (ctx.code[cfgR[0]] !== '{') {
        urlR = args[0];
        cfgR = args[1] && ctx.code[args[1][0]] === '{' ? args[1] : null;
      }
      if (cfgR) {
        const props = objectProps(ctx, cfgR[0]);
        const u = props.get('url');
        if (u && !urlR) urlR = [u.s, u.e];
        const mth = props.get('method');
        if (mth) method = methodFromValue(ctx, mth.s, mth.e, env);
        const b = props.get('baseURL');
        if (b) call = { ...call, baseRange: [b.s, b.e] };
      }
      if (!method) method = { method: 'GET' };
    }
    if (call.optionsArg !== undefined) {
      const args = callArgs(ctx, call.open);
      const o = args[call.optionsArg];
      method = { method: 'GET' };
      if (o && ctx.code[o[0]] === '{') {
        const mth = objectProps(ctx, o[0]).get('method');
        if (mth) method = methodFromValue(ctx, mth.s, mth.e, env);
      }
    }
    if (call.methodArg !== undefined) {
      const r = argRange(ctx, call, call.methodArg);
      method = r ? methodFromValue(ctx, r[0], r[1], env) : { method: null };
    }
    if (call.methodRange) method = methodFromValue(ctx, call.methodRange[0], call.methodRange[1], env);
    if (!urlR) return { value: val(DYN, null, '', 0.5), method: method || { method: null }, via: call.via };
    value = evalExpr(ctx, urlR[0], urlR[1], env);
    let via = call.via;
    // receiver base (axios.create / httpx base_url / C# BaseAddress / typed client)
    if (!value.base) {
      let rb = null;
      if (call.baseRange) rb = evalExpr(ctx, call.baseRange[0], call.baseRange[1], { depth: 0 });
      else if (ctx.lang === 'cs') {
        const r = csReceiverBase(ctx, call);
        if (r) {
          rb = r.value;
          if (r.typed) via = 'typed-client';
        }
      }
      if (rb && rb.base) {
        const rel = value.text.startsWith(MARK) || value.text.startsWith(DYN) ? value.text : value.text;
        value = { base: rb.base, suffix: rb.suffix + rb.text, text: rel, conf: Math.min(rb.conf, value.conf) };
      }
    }
    return { value, method: method || { method: null }, via };
  }
  // callee: helper call
  const segs = call.chain.segs;
  const target = resolveCallee(ctx, segs, { depth: 0 });
  if (!target) return null;
  const helper = getHelper(target.fn);
  if (!helper) return null;
  const args = callArgs(ctx, call.open);
  const argVal = (i) => {
    if (args[i]) return evalExpr(ctx, args[i][0], args[i][1], env);
    const p = target.fn.params[i];
    if (p && p.defS !== null) return evalExpr(target.fn.ctx, p.defS, p.defE, { depth: 0 });
    return dyn();
  };
  // instantiate template
  const t = helper.template;
  let out = { base: t.base, suffix: t.suffix, text: '', conf: t.conf };
  const pieces = t.text.split(/(\u0001[\s\S])/);
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece[0] === MARK) {
      const v = argVal(piece.charCodeAt(1) - 0x30);
      if (!out.base && out.text === '' && v.base) out = { ...v, conf: Math.min(out.conf, v.conf) };
      else if (v.base) out = { ...out, text: out.text + DYN, conf: Math.min(out.conf, v.conf) * 0.9 };
      else out = { ...out, text: out.text + v.text, conf: Math.min(out.conf, v.conf) };
    } else out = { ...out, text: out.text + piece };
  }
  let method = helper.method;
  if (method && method.param !== undefined) {
    const i = method.param;
    if (args[i]) method = methodFromValue(ctx, args[i][0], args[i][1], env);
    else {
      const p = target.fn.params[i];
      if (p && p.defS !== null) method = methodFromValue(target.fn.ctx, p.defS, p.defE, { depth: 0 });
      else method = { method: null };
    }
  }
  const via = helper.rootVia === 'superagent' && helper.isProp ? 'superagent-wrapper' : helper.rootVia === 'HttpClient' || helper.rootVia === 'typed-client' ? helper.rootVia : 'helper';
  return { value: out, method, via, viaHelper: true };
}

function csReceiverBase(ctx, call) {
  const code = ctx.code;
  if (call.receiver) {
    const recv = escRe(call.receiver);
    let best = null;
    let m;
    const re = new RegExp(`\\b${recv}\\s*=\\s*new\\s*(?:HttpClient\\s*)?(?:\\([^;{]*?\\))?\\s*\\{`, 'g');
    while ((m = re.exec(code)) && m.index < call.s) {
      const open = m.index + m[0].length - 1;
      const p = objectProps(ctx, open).get('BaseAddress');
      if (p) best = [p.s, p.e];
    }
    const re2 = new RegExp(`\\b${recv}\\s*\\.\\s*BaseAddress\\s*=\\s*`, 'g');
    while ((m = re2.exec(code)) && m.index < call.s) {
      const s = m.index + m[0].length;
      best = [s, csExprEnd(ctx, s)];
    }
    if (best) return { value: evalExpr(ctx, best[0], best[1], { depth: 0 }) };
  }
  // typed client registered for the enclosing class
  const cls = (ctx.classes || []).filter((c) => c.bodyS <= call.s && call.s < c.bodyE).sort((a, b) => (a.bodyE - a.bodyS) - (b.bodyE - b.bodyS))[0];
  if (!cls) return null;
  const regs = csRegistrations(ctx.member);
  const r = regs.get(cls.name);
  if (r) return { value: r, typed: true };
  return null;
}

function csRegistrations(member) {
  if (member.registrations) return member.registrations;
  const regs = new Map();
  for (const f of member.files) {
    if (!f.endsWith('.cs')) continue;
    const src = member.read(f);
    if (!src || !src.includes('AddHttpClient')) continue;
    const ctx = member.ctx(f);
    if (!ctx) continue;
    const re = /\bAddHttpClient\s*(?:<\s*([\w.]+)\s*(?:,\s*([\w.]+))?\s*>)?\s*\(/g;
    let m;
    while ((m = re.exec(ctx.code))) {
      const open = m.index + m[0].length - 1;
      const close = ctx.close(open);
      if (close === undefined) continue;
      const cls = (m[2] || m[1] || '').split('.').pop();
      const args = callArgs(ctx, open);
      let name = cls;
      if (args[0]) {
        const lit = stringAt(ctx, args[0][0], args[0][1]);
        if (lit && !cls) name = lit;
        else if (lit && cls) regs.set(`#name:${lit}`, null);
      }
      const ba = /\bBaseAddress\s*=\s*/g;
      ba.lastIndex = open;
      let mm;
      let value = null;
      while ((mm = ba.exec(ctx.code)) && mm.index < close) {
        const s = mm.index + mm[0].length;
        value = evalExpr(ctx, s, csExprEnd(ctx, s), { depth: 0 });
      }
      if (name && value && value.base) {
        regs.set(name, value);
        if (args[0]) {
          const lit = stringAt(ctx, args[0][0], args[0][1]);
          if (lit) regs.set(`#name:${lit}`, value);
        }
      }
    }
  }
  member.registrations = regs;
  return regs;
}

function headMarker(v) {
  if (v.suffix && /[?&=]/.test(v.suffix)) return false;
  return v.text.startsWith(MARK);
}

function getHelper(fn) {
  const member = fn.ctx.member;
  const key = `${fn.ctx.rel}:${fn.start}:${fn.bodyS}`;
  if (member.helperMemo.has(key)) return member.helperMemo.get(key);
  member.helperMemo.set(key, null);
  const ctx = fn.ctx;
  let helper = null;
  for (const call of collectCalls(ctx)) {
    if (call.s < fn.bodyS || call.s >= fn.bodyE) continue;
    if (innermostFn(ctx, call.s) !== fn) continue;
    const r = analyzeCall(ctx, call, fn);
    if (!r || !headMarker(r.value)) continue;
    let rootVia = r.via;
    if (r.viaHelper) {
      const target = resolveCallee(ctx, call.chain.segs, { depth: 0 });
      const h = target && getHelper(target.fn);
      rootVia = h ? h.rootVia : r.via;
    }
    helper = {
      template: r.value,
      method: r.method,
      rootVia,
      isProp: !!fn.name && isObjectProperty(ctx, fn),
    };
    break;
  }
  member.helperMemo.set(key, helper);
  return helper;
}

function isObjectProperty(ctx, fn) {
  const before = ctx.code.slice(Math.max(0, fn.start - 120), fn.start);
  return new RegExp(`${escRe(fn.name)}\\s*:\\s*(async\\s*)?$`).test(before);
}

function finalizeConsumer(ctx, call, r) {
  let { value } = r;
  const conf0 = value.conf;
  let base = value.base;
  let suffix = value.suffix || '';
  let text = value.text.replace(MARKER_RE, DYN);
  if (!base) {
    const abs = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\0]+)/i.exec(text);
    if (abs) {
      base = { type: 'literal', name: null, value: abs[1] };
      text = text.slice(abs[1].length);
    }
  }
  let path;
  if (!base && (text === '' || text.startsWith(DYN))) {
    path = null;
  } else {
    // when the whole URL came from a base constant, it is the path, not a suffix
    const pathOnly = normalizeRoute(text, { consumer: true });
    if ((pathOnly === '/' || text.startsWith('?') || text === '' || /^\0*$/.test(text)) && suffix) {
      path = normalizeRoute(suffix + text, { consumer: true });
      suffix = '';
    } else path = pathOnly;
    if (base && text.startsWith(DYN) && !suffix) path = path === '/{}' ? null : path;
  }
  const outBase = base
    ? { type: base.type, name: base.name ?? null, value: base.value ?? null, suffix: normalizeSuffix(suffix), ...(base.fallbacks ? { fallbacks: base.fallbacks } : {}) }
    : { type: 'unknown', name: null, value: null, suffix: normalizeSuffix(suffix) };
  const method = r.method && r.method.method ? r.method.method : r.method && r.method.method === null ? 'GET' : 'GET';
  let confidence = conf0;
  if (!r.method || !r.method.method) confidence = Math.min(confidence, 0.8);
  if (!base) confidence = Math.min(confidence, 0.5);
  if (path === null) confidence = Math.min(confidence, 0.3);
  return {
    kind: 'http',
    method,
    path,
    base: outBase,
    via: r.via,
    file: ctx.rel,
    line: ctx.line(call.s),
    confidence: Math.round(confidence * 100) / 100,
  };
}

function extractConsumers(ctx) {
  const out = [];
  for (const call of collectCalls(ctx)) {
    const fn = innermostFn(ctx, call.s);
    let r;
    try {
      r = analyzeCall(ctx, call, fn);
    } catch (err) {
      warn(`${ctx.rel}:${ctx.line(call.s)}: ${err.message}`);
      continue;
    }
    if (!r) continue;
    if (fn && headMarker(r.value)) continue; // helper body, reported at its call sites
    out.push(finalizeConsumer(ctx, call, r));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers — ASP.NET Core
// ---------------------------------------------------------------------------

/** Parse `[A(...), B]` attribute blocks preceding position `pos` (masked code). */
function attributeBlocksBefore(ctx, pos) {
  const code = ctx.code;
  const attrs = [];
  let i = skipWsBack(code, pos - 1);
  // skip modifiers
  for (;;) {
    if (code[i] === ']') {
      const o = ctx.close(i);
      if (o === undefined) break;
      attrs.unshift(...parseAttributeList(ctx, o + 1, i));
      i = skipWsBack(code, o - 1);
      continue;
    }
    const w = /([A-Za-z_]\w*)$/.exec(code.slice(Math.max(0, i - 40), i + 1));
    if (w && ['public', 'private', 'protected', 'internal', 'static', 'sealed', 'abstract', 'partial', 'async', 'virtual', 'override', 'new', 'readonly', 'unsafe', 'extern'].includes(w[1])) {
      i = skipWsBack(code, i - w[1].length);
      continue;
    }
    break;
  }
  return attrs;
}

function parseAttributeList(ctx, s, e) {
  const out = [];
  for (const [a, b] of splitTop(ctx, s, e, ',')) {
    const m = /^(?:[A-Za-z_]\w*\s*:\s*)?([A-Za-z_][\w.]*)\s*(\()?/.exec(ctx.code.slice(a, b));
    if (!m) continue;
    const name = m[1].split('.').pop().replace(/Attribute$/, '');
    let args = [];
    if (m[2]) args = callArgs(ctx, a + m[0].length - 1);
    out.push({ name, args, at: a });
  }
  return out;
}

function csConstString(ctx, s, e) {
  const v = evalExpr(ctx, s, e, { depth: 0 });
  if (v.base || v.text.includes(DYN)) return null;
  return v.text;
}

function csConstInt(ctx, s, e) {
  const txt = ctx.code.slice(s, e).trim();
  if (/^-?\d+$/.test(txt)) return Number(txt);
  if (/^int\s*\.\s*MaxValue$/.test(txt)) return 2147483647;
  if (/^int\s*\.\s*MinValue$/.test(txt)) return -2147483648;
  const d = ctx.decls.find((x) => x.name === txt);
  if (d) return csConstInt(ctx, d.s, d.e);
  return 0;
}

const CS_VERB_ATTRS = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', HttpHead: 'HEAD', HttpOptions: 'OPTIONS' };

function routeAttrInfo(ctx, attr) {
  let template = null;
  let order = 0;
  for (const [a, b] of attr.args) {
    const named = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(ctx.code.slice(a, b));
    if (named) {
      if (named[1] === 'Order') order = csConstInt(ctx, skipWs(ctx.code, a + named[0].length, b), b);
      continue;
    }
    if (template === null) template = csConstString(ctx, a, b);
  }
  return { template, order };
}

function combineRoute(classTpl, actionTpl) {
  if (actionTpl !== null && actionTpl !== undefined && (actionTpl.startsWith('/') || actionTpl.startsWith('~/'))) return actionTpl.replace(/^~/, '');
  if (classTpl === null || classTpl === undefined) return actionTpl ?? '';
  if (actionTpl === null || actionTpl === undefined || actionTpl === '') return classTpl;
  return classTpl.replace(/\/+$/, '') + '/' + actionTpl;
}

function csConventions(member) {
  if (member._conventions) return member._conventions;
  const out = [];
  const csprojDirs = member.files.filter((f) => f.endsWith('.csproj')).map((f) => (posix.dirname(f) === '.' ? '' : posix.dirname(f)));
  const registered = new Set();
  for (const f of member.files) {
    if (!f.endsWith('.cs')) continue;
    const src = member.read(f);
    if (!src) continue;
    let m;
    const reg = /Conventions\s*\.\s*(?:Add|Insert)\s*\(\s*(?:\d+\s*,\s*)?new\s+([\w.]+)/g;
    while ((m = reg.exec(src))) registered.add(m[1].split('.').pop());
  }
  const idx = csIndex(member);
  for (const [name, { ctx, cls }] of idx.classes) {
    if (!/IApplicationModelConvention|IControllerModelConvention/.test(cls.header)) continue;
    if (!registered.has(name)) continue;
    const body = ctx.code.slice(cls.bodyS, cls.bodyE);
    const tm = /\bTemplate\s*=\s*/.exec(body);
    if (!tm) continue;
    const s = cls.bodyS + tm.index + tm[0].length;
    const e = csExprEnd(ctx, s);
    // constant prefix: leading `+` pieces that evaluate to constants
    const plus = topLevelOps(ctx, s, e, (c, i) => (c[i] === '+' ? 1 : 0));
    let prefix = '';
    let start = s;
    const bounds = [...plus.map(([i]) => i), e];
    for (const b of bounds) {
      const v = evalExpr(ctx, start, b, { depth: 0 });
      if (v.base || v.text.includes(DYN) || v.text.includes(MARK)) break;
      prefix += v.text;
      start = b + 1;
    }
    prefix = prefix.replace(/\/+$/, '');
    if (!prefix) continue;
    // scope
    let scope = { kind: 'all' };
    const am = /ControllerType\s*\.\s*Assembly\s*==\s*([\w.]+(?:\s*\(\s*[\w.]+\s*\)\s*\.\s*Assembly)?)/.exec(body) || /==\s*([\w.]+)\s*\)?\s*\)?\s*\.?\s*$/.exec('');
    if (am) {
      let typeName = null;
      const direct = /typeof\s*\(\s*([\w.]+)\s*\)/.exec(am[1]);
      if (direct) typeName = direct[1];
      else {
        // static field: Assembly = typeof(T).Assembly in this file / class
        const d = ctx.decls.filter((x) => x.name === am[1].split('.').pop()).map((x) => ctx.src.slice(x.s, x.e)).find((t) => /typeof/.test(t));
        const tm2 = d && /typeof\s*\(\s*([\w.]+)\s*\)/.exec(d);
        if (tm2) typeName = tm2[1];
      }
      if (typeName) {
        const tcls = idx.classes.get(typeName.split('.').pop());
        if (tcls) {
          const file = tcls.ctx.rel;
          const proj = csprojDirs.filter((d) => d === '' || file.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0];
          scope = { kind: 'dir', dir: proj ?? '' };
        }
      }
    }
    const nm = /ControllerType\s*\.\s*Namespace[^;]*?(?:StartsWith|==)\s*\(?\s*"([^"]+)"/.exec(ctx.src.slice(cls.bodyS, cls.bodyE));
    if (nm) scope = { kind: 'ns', ns: nm[1] };
    out.push({ name, prefix, scope });
  }
  member._conventions = out;
  return out;
}

function extractAspNet(ctx, providers) {
  const code = ctx.code;
  const conventions = csConventions(ctx.member);
  for (const cls of ctx.classes || []) {
    if (cls.kind !== 'class' && cls.kind !== 'record') continue;
    const clsAttrs = attributeBlocksBefore(ctx, cls.start);
    const isController = /Controller$/.test(cls.name) || clsAttrs.some((a) => a.name === 'ApiController' || a.name === 'Route') || /:\s*[^{]*\b(ControllerBase|Controller)\b/.test(cls.header);
    if (!isController) continue;
    const ctrlName = cls.name.replace(/Controller$/, '');
    const classRoutes = clsAttrs.filter((a) => a.name === 'Route' || a.name === 'RoutePrefix').map((a) => routeAttrInfo(ctx, a).template).filter((t) => t !== null);
    const conv = conventions.find((c) => (c.scope.kind === 'all') || (c.scope.kind === 'dir' && (c.scope.dir === '' || ctx.rel.startsWith(c.scope.dir + '/'))) || (c.scope.kind === 'ns' && (ctx.namespace || '').startsWith(c.scope.ns)));
    // methods directly inside the class
    for (const fn of ctx.fns) {
      if (fn.start < cls.bodyS || fn.start >= cls.bodyE) continue;
      // nested class?
      const inner = (ctx.classes || []).find((c) => c !== cls && c.bodyS > cls.bodyS && c.bodyE < cls.bodyE && fn.start > c.bodyS && fn.start < c.bodyE);
      if (inner) continue;
      if (innermostFn(ctx, fn.start)) continue;
      const attrs = attributeBlocksBefore(ctx, declStart(ctx, fn.start));
      const verbs = [];
      const routes = [];
      for (const a of attrs) {
        if (CS_VERB_ATTRS[a.name]) {
          const info = routeAttrInfo(ctx, a);
          verbs.push({ method: CS_VERB_ATTRS[a.name], ...info, at: a.at });
        } else if (a.name === 'AcceptVerbs') {
          for (const [x, y] of a.args) {
            const lit = stringAt(ctx, x, y);
            if (lit) verbs.push({ method: lit.toUpperCase(), template: null, order: 0, at: a.at });
          }
        } else if (a.name === 'Route') routes.push({ ...routeAttrInfo(ctx, a), at: a.at });
      }
      if (!verbs.length && !routes.length) continue;
      const actionName = fn.name.replace(/Async$/, '');
      const entries = [];
      if (verbs.length) {
        for (const v of verbs) {
          if (v.template === null && routes.length) for (const r of routes) entries.push({ method: v.method, template: r.template, order: r.order || v.order, at: v.at });
          else entries.push(v);
        }
      } else for (const r of routes) entries.push({ method: 'ANY', template: r.template, order: r.order, at: r.at });
      const clsList = classRoutes.length ? classRoutes : [null];
      for (const en of entries) {
        for (const cr of clsList) {
          let combined = combineRoute(cr, en.template);
          if (conv) combined = '/' + conv.prefix.replace(/^\/+/, '') + '/' + combined.replace(/^\/+/, '');
          combined = combined.replace(/\[controller\]/gi, ctrlName).replace(/\[action\]/gi, actionName).replace(/\[area\]/gi, '{area}');
          const rawRoute = en.template ?? cr ?? '';
          const catchAll = /\{\*\*?[^}]*\}/.test(combined);
          providers.push({
            kind: 'http',
            method: en.method,
            route: normalizeRoute(combined),
            rawRoute: rawRoute.replace(/\[controller\]/gi, '[controller]'),
            framework: 'aspnet',
            file: ctx.rel,
            line: ctx.line(en.at),
            symbol: `${cls.name}.${fn.name}`,
            catchAll,
            order: en.order || 0,
          });
        }
      }
    }
  }
  // minimal APIs
  const groups = new Map();
  let m;
  const grpRe = /\b(?:var|const)?\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*\.\s*MapGroup\s*\(/g;
  while ((m = grpRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(ctx, open);
    const tpl = args[0] ? csConstString(ctx, args[0][0], args[0][1]) : null;
    if (tpl === null) continue;
    const parent = groups.get(m[2]) || '';
    groups.set(m[1], parent.replace(/\/+$/, '') + '/' + tpl.replace(/^\/+/, ''));
  }
  const mapRe = /\b([A-Za-z_]\w*)\s*\.\s*(MapGet|MapPost|MapPut|MapDelete|MapPatch|MapMethods|MapHealthChecks)\s*\(/g;
  while ((m = mapRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(ctx, open);
    if (!args.length) continue;
    const tpl = csConstString(ctx, args[0][0], args[0][1]);
    if (tpl === null) continue;
    const prefix = groups.get(m[1]) || '';
    const route = prefix ? prefix.replace(/\/+$/, '') + '/' + tpl.replace(/^\/+/, '') : tpl;
    let methods;
    if (m[2] === 'MapMethods') {
      methods = [];
      if (args[1]) {
        const re2 = /"([A-Za-z]+)"/g;
        let mm;
        const txt = ctx.src.slice(args[1][0], args[1][1]);
        while ((mm = re2.exec(txt))) methods.push(mm[1].toUpperCase());
      }
    } else methods = [m[2] === 'MapHealthChecks' ? 'GET' : m[2].slice(3).toUpperCase()];
    for (const method of methods) {
      providers.push({
        kind: 'http', method, route: normalizeRoute(route), rawRoute: tpl, framework: 'aspnet', file: ctx.rel, line: ctx.line(m.index),
        catchAll: /\{\*/.test(tpl), order: 0,
      });
    }
  }
}

function declStart(ctx, nameAt) {
  // walk back over return type and modifiers to where attributes would end
  const code = ctx.code;
  let i = nameAt - 1;
  let depthAngle = 0;
  while (i >= 0) {
    const c = code[i];
    if (c === '>') depthAngle++;
    else if (c === '<') depthAngle--;
    else if (depthAngle === 0 && (c === ';' || c === '{' || c === '}' || c === ']')) return i + 1;
    i--;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Providers — Python (FastAPI, Flask, http.server)
// ---------------------------------------------------------------------------

function pyKwString(ctx, args, kw) {
  for (const [a, b] of args) {
    const mm = new RegExp(`^${kw}\\s*=(?!=)`).exec(ctx.code.slice(a, b));
    if (mm) return stringOrConst(ctx, skipWs(ctx.code, a + mm[0].length, b), b, { depth: 0 });
  }
  return null;
}

function pyKwList(ctx, args, kw) {
  for (const [a, b] of args) {
    const mm = new RegExp(`^${kw}\\s*=(?!=)`).exec(ctx.code.slice(a, b));
    if (!mm) continue;
    const s = skipWs(ctx.code, a + mm[0].length, b);
    const out = [];
    if (ctx.code[s] === '[' || ctx.code[s] === '(' || ctx.code[s] === '{') {
      for (const [x, y] of splitTop(ctx, s + 1, ctx.close(s), ',')) {
        const lit = stringAt(ctx, x, y);
        if (lit) out.push(lit);
      }
    }
    return out;
  }
  return null;
}

function pyVars(ctx) {
  if (ctx._pyVars) return ctx._pyVars;
  const vars = new Map();
  const re = /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:[\w.]+\.)?(FastAPI|APIRouter|Flask|Blueprint)\s*\(/gm;
  let m;
  while ((m = re.exec(ctx.code))) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(ctx, open);
    const prefix = m[2] === 'APIRouter' ? pyKwString(ctx, args, 'prefix') : m[2] === 'Blueprint' ? pyKwString(ctx, args, 'url_prefix') : null;
    vars.set(m[1], { type: m[2], prefix: prefix || '' });
  }
  ctx._pyVars = vars;
  return vars;
}

function pyMounts(member) {
  if (member._pyMounts) return member._pyMounts;
  const includes = []; // { includerCtx, includerVar, targetCtx, targetVar, prefix }
  for (const f of member.files) {
    if (!f.endsWith('.py')) continue;
    const src = member.read(f);
    if (!src || !/include_router|register_blueprint/.test(src)) continue;
    const ctx = member.ctx(f);
    if (!ctx) continue;
    const re = /\b([A-Za-z_][\w.]*)\s*\.\s*(include_router|register_blueprint)\s*\(/g;
    let m;
    while ((m = re.exec(ctx.code))) {
      const open = m.index + m[0].length - 1;
      const args = callArgs(ctx, open);
      if (!args.length) continue;
      const prefix = pyKwString(ctx, args, m[2] === 'include_router' ? 'prefix' : 'url_prefix');
      const targetTxt = ctx.code.slice(args[0][0], args[0][1]).replace(/\s+/g, '');
      const parts = targetTxt.split('.');
      let target = null;
      if (parts.length === 1) {
        const imp = resolveImport(ctx, parts[0]);
        if (imp && imp.ctx) target = { ctx: imp.ctx, name: imp.name === '*' ? 'router' : imp.name };
        else target = { ctx, name: parts[0] };
      } else if (parts.length >= 2) {
        const imp = resolveImport(ctx, parts[0]);
        if (imp && imp.ctx) target = { ctx: imp.ctx, name: parts[parts.length - 1] };
      }
      if (!target) continue;
      includes.push({ includerCtx: ctx, includerVar: m[1].split('.').pop(), target, prefix: prefix ?? null, kind: m[2] });
    }
  }
  member._pyMounts = includes;
  return includes;
}

function pyRouterPrefixes(member, ctx, varName, seen = new Set()) {
  const key = `${ctx.rel}:${varName}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const vars = pyVars(ctx);
  const info = vars.get(varName);
  if (info && (info.type === 'FastAPI' || info.type === 'Flask')) return [''];
  const includes = pyMounts(member).filter((i) => i.target.ctx === ctx && i.target.name === varName);
  if (!includes.length) {
    const anyFastApiInclude = pyMounts(member).some((i) => i.kind === 'include_router');
    const anyBlueprint = pyMounts(member).some((i) => i.kind === 'register_blueprint');
    if (info && info.type === 'APIRouter' && anyFastApiInclude) return [];
    if (info && info.type === 'Blueprint' && anyBlueprint) return [];
    return [''];
  }
  const out = [];
  for (const inc of includes) {
    const parents = pyRouterPrefixes(member, inc.includerCtx, inc.includerVar, seen);
    const parentsOrRoot = parents.length ? parents : (pyVars(inc.includerCtx).has(inc.includerVar) ? [] : ['']);
    for (const p of parentsOrRoot) out.push(joinRoute(p, inc.prefix ?? ''));
  }
  return out;
}

function joinRoute(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '');
}

function extractPython(ctx, providers) {
  const code = ctx.code;
  const member = ctx.member;
  const vars = pyVars(ctx);
  const importsFastapi = [...ctx.imports.values()].some((i) => (i.mod || '').startsWith('fastapi'));
  const importsFlask = [...ctx.imports.values()].some((i) => (i.mod || '').startsWith('flask'));
  const re = /^[ \t]*@\s*([A-Za-z_][\w.]*)\s*\.\s*(get|post|put|delete|patch|head|options|api_route|route|websocket)\s*\(/gm;
  let m;
  while ((m = re.exec(code))) {
    const recv = m[1];
    const open = m.index + m[0].length - 1;
    const args = callArgs(ctx, open);
    const positional = args.filter(([a, b]) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(code.slice(a, b)));
    let path = positional[0] ? stringOrConst(ctx, positional[0][0], positional[0][1], { depth: 0 }) : null;
    if (path === null) path = pyKwString(ctx, args, 'path') ?? pyKwString(ctx, args, 'rule');
    if (path === null) continue;
    const info = vars.get(recv);
    let framework;
    if (info) framework = info.type === 'Flask' || info.type === 'Blueprint' ? 'flask' : 'fastapi';
    else if (importsFlask && (m[2] === 'route')) framework = 'flask';
    else if (importsFastapi || m[2] !== 'route') framework = importsFlask ? 'flask' : 'fastapi';
    let methods;
    if (m[2] === 'route' || m[2] === 'api_route') methods = (pyKwList(ctx, args, 'methods') || ['GET']).map((x) => x.toUpperCase());
    else if (m[2] === 'websocket') methods = ['GET'];
    else methods = [m[2].toUpperCase()];
    const prefixes = info ? pyRouterPrefixes(member, ctx, recv) : [''];
    const own = info ? info.prefix : '';
    // function name: next `def`
    const dm = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/m.exec(code.slice(ctx.close(open)));
    const at = m.index + (m[0].length - m[0].trimStart().length);
    for (const p of prefixes) {
      for (const method of methods) {
        providers.push({
          kind: 'http', method, route: normalizeRoute(joinRoute(joinRoute(p, own), path)), rawRoute: path, framework,
          file: ctx.rel, line: ctx.line(at), symbol: dm ? dm[1] : undefined, catchAll: /\{[^}]*:path\}|<path:/.test(path), order: 0,
        });
      }
    }
  }
  // http.server: BaseHTTPRequestHandler.do_GET with literal self.path comparisons
  const clsRe = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)\s*\(([^)]*BaseHTTPRequestHandler[^)]*)\)\s*:/gm;
  while ((m = clsRe.exec(code))) {
    for (const fn of ctx.fns) {
      const mm = /^do_([A-Z]+)$/.exec(fn.name || '');
      if (!mm || fn.start < m.index) continue;
      const body = code.slice(fn.bodyS, fn.bodyE);
      const seen = new Set();
      const pr = /\bpath\b(?:\s*\.\s*split\s*\([^)]*\)\s*\[\s*0\s*\])?\s*(?:==|!=|\bin\b|\.startswith\s*\()\s*[([{]?/g;
      let pm;
      while ((pm = pr.exec(body))) {
        let k = fn.bodyS + pm.index + pm[0].length;
        // collect string literals right after the comparison
        for (let guard = 0; guard < 8; guard++) {
          k = skipWs(code, k);
          const tok = ctx.strings.get(k);
          if (!tok) break;
          const lit = literalOf(tok);
          if (lit && lit.startsWith('/') && !seen.has(lit)) {
            seen.add(lit);
            providers.push({ kind: 'http', method: mm[1], route: normalizeRoute(lit), rawRoute: lit, framework: 'http.server', file: ctx.rel, line: ctx.line(k), symbol: `${m[2]}.${fn.name}`, catchAll: false, order: 0 });
          }
          k = skipWs(code, tok.end);
          if (code[k] === ',') k++;
          else break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Providers — Express / NestJS
// ---------------------------------------------------------------------------

function extractJsProviders(ctx, providers) {
  const code = ctx.code;
  const express = importedNamesFrom(ctx, (spec) => spec === 'express');
  const apps = new Set();
  const routers = new Set();
  let m;
  if (express.length) {
    const alt = express.map(escRe).join('|');
    const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:(${alt})\\s*\\(\\s*\\)|(?:(?:${alt})\\s*\\.\\s*)?Router\\s*\\()`, 'g');
    while ((m = re.exec(code))) {
      if (m[2]) apps.add(m[1]);
      else routers.add(m[1]);
    }
  }
  const prefixes = new Map();
  for (const app of apps) {
    const re = new RegExp(`\\b${escRe(app)}\\s*\\.\\s*use\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const args = callArgs(ctx, m.index + m[0].length - 1);
      if (args.length < 2) continue;
      const p = stringAt(ctx, args[0][0], args[0][1]);
      const r = code.slice(args[1][0], args[1][1]).trim();
      if (p !== null && routers.has(r)) prefixes.set(r, p);
    }
  }
  for (const recv of [...apps, ...routers]) {
    const re = new RegExp(`\\b${escRe(recv)}\\s*\\.\\s*(get|post|put|delete|patch|all|options|head)\\s*\\(`, 'g');
    while ((m = re.exec(code))) {
      const args = callArgs(ctx, m.index + m[0].length - 1);
      const p = args[0] ? stringAt(ctx, args[0][0], args[0][1]) : null;
      if (p === null) continue;
      const route = joinRoute(prefixes.get(recv) || '', p);
      providers.push({ kind: 'http', method: m[1] === 'all' ? 'ANY' : m[1].toUpperCase(), route: normalizeRoute(route), rawRoute: p, framework: 'express', file: ctx.rel, line: ctx.line(m.index), catchAll: /\*/.test(p), order: 0 });
    }
  }
  // NestJS
  const nest = importedNamesFrom(ctx, (spec) => spec === '@nestjs/common');
  if (!nest.length) return;
  const globalPrefix = nestGlobalPrefix(ctx.member);
  const ctrlRe = /@Controller\s*\(/g;
  while ((m = ctrlRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(ctx, open);
    let base = '';
    if (args[0]) {
      base = stringAt(ctx, args[0][0], args[0][1]) ?? '';
      if (code[args[0][0]] === '{') {
        const p = objectProps(ctx, args[0][0]).get('path');
        if (p) base = stringAt(ctx, p.s, p.e) ?? '';
      }
    }
    const cm = /class\s+([A-Za-z_$][\w$]*)[^{]*\{/.exec(code.slice(ctx.close(open)));
    if (!cm) continue;
    const bodyOpen = ctx.close(open) + cm.index + cm[0].length - 1;
    const bodyClose = ctx.close(bodyOpen);
    const vre = /@(Get|Post|Put|Delete|Patch|All|Options|Head)\s*\(/g;
    vre.lastIndex = bodyOpen;
    let vm;
    while ((vm = vre.exec(code)) && vm.index < bodyClose) {
      const vopen = vm.index + vm[0].length - 1;
      const vargs = callArgs(ctx, vopen);
      const p = vargs[0] ? stringAt(ctx, vargs[0][0], vargs[0][1]) ?? '' : '';
      const nm = /^\s*(?:@[\w.]+\s*(?:\([^)]*\))?\s*)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(ctx.close(vopen) + 1));
      const route = joinRoute(joinRoute(globalPrefix, base), p);
      providers.push({ kind: 'http', method: vm[1] === 'All' ? 'ANY' : vm[1].toUpperCase(), route: normalizeRoute(route), rawRoute: p, framework: 'nestjs', file: ctx.rel, line: ctx.line(vm.index), symbol: nm ? `${cm[1]}.${nm[1]}` : undefined, catchAll: /\*/.test(p), order: 0 });
    }
  }
}

function nestGlobalPrefix(member) {
  if (member._nestPrefix !== undefined) return member._nestPrefix;
  member._nestPrefix = '';
  for (const f of member.files) {
    if (!/\.[cm]?[jt]s$/.test(f)) continue;
    const src = member.read(f);
    if (!src || !src.includes('setGlobalPrefix')) continue;
    const m = /setGlobalPrefix\s*\(\s*['"`]([^'"`]*)['"`]/.exec(src);
    if (m) {
      member._nestPrefix = m[1];
      break;
    }
  }
  return member._nestPrefix;
}

// ---------------------------------------------------------------------------
// Messages (queues / topics / commands)
// ---------------------------------------------------------------------------

const CHANNEL_RE = /^[A-Za-z0-9][\w.:*#\-/]*$/;

function channelArg(ctx, r) {
  if (!r) return null;
  let v = stringOrConst(ctx, r[0], r[1], { depth: 0 });
  if (v === null) {
    // channel from config with a literal default: os.getenv("CODEQ_COMMAND", "fortesec.carga")
    const ev = evalExpr(ctx, r[0], r[1], { depth: 0 });
    if (ev.base && ev.base.default && !ev.text && !ev.suffix) v = ev.base.default;
  }
  if (v === null || !CHANNEL_RE.test(v)) return null;
  return v;
}

function kwOrPos(ctx, args, kw, pos) {
  for (const [a, b] of args) {
    const mm = new RegExp(`^${kw}\\s*[:=](?![=])`).exec(ctx.code.slice(a, b));
    if (mm) return [skipWs(ctx.code, a + mm[0].length, b), b];
  }
  const positional = args.filter(([a, b]) => !/^[A-Za-z_]\w*\s*[:=](?!=)/.test(ctx.code.slice(a, b)));
  return positional[pos] || null;
}

function systemsByImports(ctx) {
  const specs = [...ctx.imports.values()].map((i) => i.spec ?? i.mod ?? '');
  const src = ctx.src;
  const out = new Set();
  if (specs.some((s) => /kafka/i.test(s)) || /Confluent\.Kafka/.test(src)) out.add('kafka');
  if (specs.some((s) => /amqp|pika|rabbit/i.test(s)) || /RabbitMQ\.Client/.test(src)) out.add('rabbitmq');
  if (specs.some((s) => /redis/i.test(s)) || /StackExchange\.Redis/.test(src)) out.add('redis');
  return out;
}

function extractMessages(ctx, msgs, memberFlags) {
  const code = ctx.code;
  const add = (kind, channel, system, at) => {
    if (!channel) return;
    msgs[kind].push({ channel, system, file: ctx.rel, line: ctx.line(at) });
  };
  const syss = systemsByImports(ctx);
  let m;
  const scan = (re, fn) => {
    re.lastIndex = 0;
    while ((m = re.exec(code))) fn(m, callArgs(ctx, m.index + m[0].length - 1));
  };
  if (ctx.lang === 'js') {
    scan(/\.\s*send\s*\(\s*(?=\{)/g, (mm, args) => {
      const p = objectProps(ctx, args[0][0]).get('topic');
      if (p) add('publish', channelArg(ctx, [p.s, p.e]), 'kafka', mm.index);
    });
    scan(/\.\s*subscribe\s*\(/g, (mm, args) => {
      if (!args[0]) return;
      if (code[args[0][0]] === '{') {
        const props = objectProps(ctx, args[0][0]);
        const t = props.get('topic');
        if (t) add('subscribe', channelArg(ctx, [t.s, t.e]), 'kafka', mm.index);
        const ts = props.get('topics');
        if (ts && code[ts.s] === '[') for (const r of splitTop(ctx, ts.s + 1, ctx.close(ts.s), ',')) add('subscribe', channelArg(ctx, r), 'kafka', mm.index);
      } else if (syss.has('redis')) add('subscribe', channelArg(ctx, args[0]), 'redis', mm.index);
    });
    scan(/\.\s*(sendToQueue|consume)\s*\(/g, (mm, args) => add(mm[1] === 'consume' ? 'subscribe' : 'publish', channelArg(ctx, args[0]), 'rabbitmq', mm.index));
    scan(/\.\s*publish\s*\(/g, (mm, args) => {
      if (syss.has('rabbitmq')) add('publish', channelArg(ctx, args[1]) || channelArg(ctx, args[0]), 'rabbitmq', mm.index);
      else if (syss.has('redis')) add('publish', channelArg(ctx, args[0]), 'redis', mm.index);
    });
  } else if (ctx.lang === 'py') {
    scan(/\.\s*(send|produce)\s*\(/g, (mm, args) => {
      if (syss.has('kafka')) add('publish', channelArg(ctx, kwOrPos(ctx, args, 'topic', 0)), 'kafka', mm.index);
    });
    scan(/\bKafkaConsumer\s*\(/g, (mm, args) => {
      for (const r of args.filter(([a, b]) => !/^[A-Za-z_]\w*\s*=/.test(code.slice(a, b)))) add('subscribe', channelArg(ctx, r), 'kafka', mm.index);
    });
    scan(/\.\s*(subscribe|psubscribe)\s*\(/g, (mm, args) => {
      if (!args[0]) return;
      if (code[args[0][0]] === '[' || code[args[0][0]] === '(') {
        const system = syss.has('kafka') ? 'kafka' : syss.has('redis') ? 'redis' : 'unknown';
        for (const r of splitTop(ctx, args[0][0] + 1, ctx.close(args[0][0]), ',')) add('subscribe', channelArg(ctx, r), system, mm.index);
      } else add('subscribe', channelArg(ctx, args[0]), syss.has('redis') ? 'redis' : syss.has('kafka') ? 'kafka' : 'unknown', mm.index);
    });
    scan(/\.\s*publish\s*\(/g, (mm, args) => {
      if (syss.has('redis')) add('publish', channelArg(ctx, args[0]), 'redis', mm.index);
    });
    scan(/\.\s*basic_publish\s*\(/g, (mm, args) => add('publish', channelArg(ctx, kwOrPos(ctx, args, 'routing_key', 1)), 'rabbitmq', mm.index));
    scan(/\.\s*basic_consume\s*\(/g, (mm, args) => add('subscribe', channelArg(ctx, kwOrPos(ctx, args, 'queue', 0)), 'rabbitmq', mm.index));
    scan(/\bsend_task\s*\(/g, (mm, args) => add('publish', channelArg(ctx, args[0]), 'celery', mm.index));
    // CodeQ: commands=[...] in claim options
    scan(/\bcommands\s*=\s*(?=[[(])/g, (mm) => {
      const open = mm.index + mm[0].length;
      for (const r of splitTop(ctx, open + 1, ctx.close(open), ',')) add('subscribe', channelArg(ctx, r), 'codeq', mm.index);
    });
    if (memberFlags.codeqConsumer) {
      const re = /^[ \t]*(TOPICOS|TOPICS|COMMANDS|COMANDOS|[A-Z_]*TOPICOS|[A-Z_]*COMMANDS)\s*(?::[^=\n]+)?=\s*(?=[[(])/gm;
      while ((m = re.exec(code))) {
        const open = m.index + m[0].length;
        for (const r of splitTop(ctx, open + 1, ctx.close(open), ',')) add('subscribe', channelArg(ctx, r), 'codeq', m.index + (m[0].length - m[0].trimStart().length));
      }
    }
    if (/codeq/i.test(ctx.src)) {
      const kre = /["'](commands?)["']\s*:\s*/g;
      let km;
      while ((km = kre.exec(ctx.src))) {
        const mm = km;
        if (!ctx.strings.has(mm.index)) continue;
        const s = mm.index + mm[0].length;
        const kind = mm[1] === 'commands' ? 'subscribe' : 'publish';
        if (code[s] === '[' || code[s] === '(') {
          for (const r of splitTop(ctx, s + 1, ctx.close(s), ',')) add(kind, channelArg(ctx, r), 'codeq', mm.index);
        } else add(kind, channelArg(ctx, [s, pyLogicalEnd(ctx, s) > s ? Math.min(pyLogicalEnd(ctx, s), csExprEnd(ctx, s)) : s]), 'codeq', mm.index);
      }
    }
  } else if (ctx.lang === 'cs') {
    scan(/\.\s*(ProduceAsync|Produce)\s*\(/g, (mm, args) => add('publish', channelArg(ctx, args[0]), 'kafka', mm.index));
    scan(/\.\s*Subscribe\s*\(/g, (mm, args) => {
      if (syss.has('kafka')) add('subscribe', channelArg(ctx, args[0]), 'kafka', mm.index);
      else if (syss.has('redis')) add('subscribe', channelArg(ctx, args[0]), 'redis', mm.index);
    });
    scan(/\.\s*(BasicPublish|BasicPublishAsync)\s*\(/g, (mm, args) => add('publish', channelArg(ctx, kwOrPos(ctx, args, 'routingKey', 1)), 'rabbitmq', mm.index));
    scan(/\.\s*(BasicConsume|BasicConsumeAsync)\s*\(/g, (mm, args) => add('subscribe', channelArg(ctx, kwOrPos(ctx, args, 'queue', 0)), 'rabbitmq', mm.index));
    scan(/\.\s*(PublishAsync|Publish)\s*\(/g, (mm, args) => {
      if (syss.has('redis')) add('publish', channelArg(ctx, args[0]), 'redis', mm.index);
    });
    scan(/\.\s*(CreateSender|CreateProcessor|CreateReceiver)\s*\(/g, (mm, args) => add(mm[1] === 'CreateSender' ? 'publish' : 'subscribe', channelArg(ctx, args[0]), 'servicebus', mm.index));
    if (/codeq/i.test(ctx.src)) {
      // const/default-valued strings named *Command*/*Comando*/*Topico*/*Topic*
      for (const d of ctx.decls) {
        if (!/(command|comando|topico|topic)/i.test(d.name)) continue;
        if (innermostFn(ctx, d.at)) continue;
        const lit = stringAt(ctx, d.s, d.e);
        if (!lit || !/^[a-z0-9][a-z0-9._*-]*$/.test(lit) || ENV_NAME_RE.test(lit)) continue;
        add('publish', lit, 'codeq', d.at);
      }
    }
  }
}

function envChannels(env, msgs) {
  for (const e of env) {
    if (!e.rawValue || !/^(CODEQ_)?(TOPICOS|TOPICS|COMMANDS|COMANDOS)$/.test(e.name)) continue;
    const parts = e.rawValue.includes('=') ? e.rawValue.split(';') : e.rawValue.split(/[;,]/);
    for (const part of parts) {
      const ch = part.split(/[=:]/)[0].trim();
      if (ch && CHANNEL_RE.test(ch)) msgs.subscribe.push({ channel: ch, system: 'codeq', file: e.source, line: e.line });
    }
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const SQL_LIKE_RE = /\b(select\b[\s\S]*?\bfrom\b|insert\s+into\b|update\s+[\w[\]."`#@]+\s+set\b|delete\s+from\b|merge\s+(?:into\s+)?[\w[\]."`]+|truncate\s+table\b)/i;
const TABLE_NAME = '((?:[\\[\\]"`\\w$#@]+\\s*\\.\\s*){0,3}[\\[\\]"`\\w$#@]+)';
const SQL_KEYWORDS = new Set(['select', 'from', 'where', 'join', 'lateral', 'unnest', 'values', 'set', 'as', 'on', 'using', 'with', 'table', 'into', 'only', 'dual', 'inner', 'outer', 'left', 'right', 'cross', 'full', 'group', 'order', 'by', 'and', 'or', 'not', 'null', 'case', 'when', 'then', 'else', 'end', 'top', 'distinct', 'all', 'union', 'openquery', 'openrowset', 'openjson', 'string_split', 'generate_series']);

function cleanTable(name) {
  const t = name.replace(/\s+/g, '').replace(/[[\]"`]/g, '');
  if (!t || /^[@#:$]/.test(t) || t.includes(DYN) || /^\d/.test(t)) return null;
  if (SQL_KEYWORDS.has(t.toLowerCase())) return null;
  if (!/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*$/.test(t)) return null;
  return t;
}

function sqlTables(sql) {
  const reads = [];
  const writes = [];
  const writeAt = new Set();
  const lower = sql;
  const ctes = new Set();
  const cteRe = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+as\s*\(/gi;
  let cm;
  while ((cm = cteRe.exec(sql))) ctes.add(cm[1].toLowerCase());
  const push = (arr, name, idx) => {
    const t = cleanTable(name);
    if (t && !ctes.has(t.toLowerCase())) arr.push({ table: t, idx });
  };
  let m;
  const wre = new RegExp(`\\b(insert\\s+(?:into|overwrite\\s+table)|update|delete\\s+from|merge(?:\\s+into)?|truncate\\s+table)\\s+${TABLE_NAME}`, 'gi');
  while ((m = wre.exec(lower))) {
    if (/^update$/i.test(m[1].trim())) {
      const after = lower.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (!/^\s*(?:(?:as\s+)?[A-Za-z_]\w*\s+)?set\b/i.test(after)) continue;
    }
    push(writes, m[2], m.index);
    if (/delete\s+from/i.test(m[1])) writeAt.add(m.index + m[0].length - m[2].length);
  }
  const rre = new RegExp(`\\b(from|join|using)\\s+${TABLE_NAME}`, 'gi');
  while ((m = rre.exec(lower))) {
    const nameAt = m.index + m[0].length - m[2].length;
    if (writeAt.has(nameAt)) continue;
    const before = lower.slice(Math.max(0, m.index - 60), m.index);
    if (/\b(extract|substring|trim|position|overlay)\s*\([^()]*$/i.test(before)) continue;
    if (/\bdistinct\s*$/i.test(before) && /from/i.test(m[1])) continue;
    if (/^using$/i.test(m[1]) && !/\bmerge\b/i.test(lower.slice(0, m.index))) continue;
    push(reads, m[2], m.index);
  }
  return { reads, writes };
}

const CODE_EXT_FOR_SQL = new Set(['.cs', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.java', '.kt', '.go', '.rb', '.php', '.scala']);

function extractTables(member, rel, ctx, tables) {
  const ext = posix.extname(rel).toLowerCase();
  const add = (kind, t, line, extra = {}) => tables[kind].push({ table: t, file: rel, line, ...extra });
  if (ext === '.sql') {
    const src = member.read(rel);
    if (!src) return;
    const masked = src.replace(/--[^\n]*/g, (x) => ' '.repeat(x.length)).replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ' '));
    const starts = lineStartsOf(masked);
    const { reads, writes } = sqlTables(masked);
    for (const r of reads) add('reads', r.table, lineAt(starts, r.idx));
    for (const w of writes) add('writes', w.table, lineAt(starts, w.idx));
    return;
  }
  if (!ctx || !CODE_EXT_FOR_SQL.has(ext)) return;
  const seenTok = new Set();
  for (const tok of ctx.strings.values()) {
    if (seenTok.has(tok)) continue;
    seenTok.add(tok);
    const sql = tok.parts.map((p) => (p.lit !== undefined ? p.lit : DYN)).join('');
    if (sql.length < 8 || !SQL_LIKE_RE.test(sql)) continue;
    const { reads, writes } = sqlTables(sql);
    // offset → line: token start line + newlines in the literal before idx (approximation for interpolations)
    const baseLine = ctx.line(tok.start);
    const lineOf = (idx) => baseLine + (sql.slice(0, idx).match(/\n/g) || []).length;
    for (const r of reads) add('reads', r.table, lineOf(r.idx));
    for (const w of writes) add('writes', w.table, lineOf(w.idx));
  }
  // ORM mappings
  const code = ctx.code;
  let m;
  if (ctx.lang === 'cs') {
    const tre = /\[\s*Table\s*\(/g;
    while ((m = tre.exec(code))) {
      const args = callArgs(ctx, m.index + m[0].length - 1);
      const name = args[0] ? stringOrConst(ctx, args[0][0], args[0][1], { depth: 0 }) : null;
      if (!name) continue;
      const schemaR = args.find(([a, b]) => /^Schema\s*=/.test(code.slice(a, b)));
      const schema = schemaR ? stringAt(ctx, skipWs(code, code.indexOf('=', schemaR[0]) + 1), schemaR[1]) : null;
      const t = cleanTable(schema ? `${schema}.${name}` : name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
    const fre = /\.\s*(ToTable|ToView)\s*\(/g;
    while ((m = fre.exec(code))) {
      const args = callArgs(ctx, m.index + m[0].length - 1);
      const name = args[0] ? stringOrConst(ctx, args[0][0], args[0][1], { depth: 0 }) : null;
      if (!name) continue;
      const schema = args[1] ? stringOrConst(ctx, args[1][0], args[1][1], { depth: 0 }) : null;
      const t = cleanTable(schema ? `${schema}.${name}` : name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
  } else if (ctx.lang === 'py') {
    const tre = /\b__tablename__\s*=\s*(?=['"])/g;
    while ((m = tre.exec(code))) {
      const s = m.index + m[0].length;
      const tok = ctx.strings.get(s);
      const name = literalOf(tok);
      if (!name) continue;
      const tail = code.slice(tok.end, tok.end + 400);
      const sch = /__table_args__\s*=[^\n]*schema['"]?\s*[:=]\s*/.exec(tail);
      let schema = null;
      if (sch) {
        const t2 = ctx.strings.get(tok.end + sch.index + sch[0].length);
        schema = literalOf(t2);
      }
      const t = cleanTable(schema ? `${schema}.${name}` : name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
    const core = /\bTable\s*\(\s*(?=['"])/g;
    while ((m = core.exec(code))) {
      const tok = ctx.strings.get(m.index + m[0].length);
      const name = literalOf(tok);
      const t = name && cleanTable(name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
  } else if (ctx.lang === 'js') {
    const ent = /@Entity\s*\(\s*(?=['"])/g;
    while ((m = ent.exec(code))) {
      const name = literalOf(ctx.strings.get(m.index + m[0].length));
      const t = name && cleanTable(name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
    const tn = /\btableName\s*:\s*(?=['"])/g;
    while ((m = tn.exec(code))) {
      const name = literalOf(ctx.strings.get(m.index + m[0].length));
      const t = name && cleanTable(name);
      if (t) add('reads', t, ctx.line(m.index), { orm: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Env + services (stage 3)
// ---------------------------------------------------------------------------

const SECRET_NAME_RE = /(KEY|SECRET|PASSWORD|PASSWD|PWD|TOKEN|CREDENTIAL|PRIVATE)/i;

function looksSecretValue(v) {
  if (typeof v !== 'string') return false;
  if (/(^|;)\s*(password|pwd)\s*=/i.test(v)) return true;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*/.test(v)) return true;
  if (/-----BEGIN [A-Z ]*-----/.test(v)) return true;
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/.test(v)) return true;
  return false;
}

function isUrlLike(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s/]+/i.test(t)) return true;
  if (/^[\w.-]+:\d{2,5}(\/\S*)?$/.test(t)) return true;
  return false;
}

function envEntry(name, rawValue, source, line, scope) {
  if (name === undefined || name === null) return null;
  name = String(name);
  const value = rawValue === undefined || rawValue === null ? null : String(rawValue);
  if (SECRET_NAME_RE.test(name) || looksSecretValue(value)) {
    return { name, value: null, redacted: true, source, line, scope };
  }
  if (value !== null && isUrlLike(value)) return { name, value: value.trim(), source, line, scope };
  if (value !== null && /^(CODEQ_)?(TOPICOS|TOPICS|COMMANDS|COMANDOS)$/.test(name)) return { name, value: null, source, line, scope, rawValue: value, internalOnly: true };
  return null;
}

function yamlDocs(src) {
  if (!YAML) return [];
  try {
    const lc = new YAML.LineCounter();
    const docs = YAML.parseAllDocuments(src, { lineCounter: lc, uniqueKeys: false });
    return docs.filter((d) => !d.errors || !d.errors.length).map((d) => ({ doc: d, lc }));
  } catch {
    return [];
  }
}

function yLine(lc, node) {
  if (!node || !node.range) return 1;
  return lc.linePos(node.range[0]).line;
}

function yGet(map, key) {
  if (!map || !YAML.isMap(map)) return null;
  for (const it of map.items) if (it.key && (it.key.value ?? String(it.key)) === key) return it;
  return null;
}

function yScalar(node) {
  if (!node) return null;
  if (YAML.isScalar(node)) return node.value === null || node.value === undefined ? null : String(node.value);
  return null;
}

function kvFromYamlCollection(node, lc, cb) {
  if (!node) return;
  if (YAML.isMap(node)) {
    for (const it of node.items) cb(String(it.key?.value ?? it.key), yScalar(it.value), yLine(lc, it.key));
  } else if (YAML.isSeq(node)) {
    for (const it of node.items) {
      const s = yScalar(it);
      if (s === null) continue;
      const eq = s.indexOf('=');
      if (eq < 0) cb(s, null, yLine(lc, it));
      else cb(s.slice(0, eq), s.slice(eq + 1), yLine(lc, it));
    }
  }
}

function extractCompose(rel, src, env, services) {
  for (const { doc, lc } of yamlDocs(src)) {
    const svcs = yGet(doc.contents, 'services');
    if (!svcs || !YAML.isMap(svcs.value)) continue;
    for (const it of svcs.value.items) {
      const name = String(it.key?.value ?? it.key);
      const body = it.value;
      const ports = [];
      const portsNode = yGet(body, 'ports');
      if (portsNode && YAML.isSeq(portsNode.value)) {
        for (const p of portsNode.value.items) {
          if (YAML.isMap(p)) {
            const pub = yScalar(yGet(p, 'published')?.value);
            const tgt = yScalar(yGet(p, 'target')?.value);
            ports.push(pub ? `${pub}:${tgt}` : String(tgt));
          } else {
            const s = yScalar(p);
            if (s) ports.push(s);
          }
        }
      }
      const hostnames = [];
      for (const k of ['hostname', 'container_name']) {
        const h = yScalar(yGet(body, k)?.value);
        if (h && h !== name) hostnames.push(h);
      }
      const nets = yGet(body, 'networks');
      if (nets && YAML.isMap(nets.value)) {
        for (const n of nets.value.items) {
          const al = yGet(n.value, 'aliases');
          if (al && YAML.isSeq(al.value)) for (const a of al.value.items) if (yScalar(a)) hostnames.push(yScalar(a));
        }
      }
      services.push({ name, ports, hostnames: [...new Set(hostnames)], source: rel, line: yLine(lc, it.key) });
      kvFromYamlCollection(yGet(body, 'environment')?.value, lc, (k, v, line) => {
        const e = envEntry(k, v, rel, line, 'compose');
        if (e) env.push(e);
      });
      const build = yGet(body, 'build');
      if (build && YAML.isMap(build.value)) {
        kvFromYamlCollection(yGet(build.value, 'args')?.value, lc, (k, v, line) => {
          const e = envEntry(k, v, rel, line, 'compose');
          if (e) env.push(e);
        });
      }
    }
  }
}

function extractK8s(rel, src, env, services) {
  for (const { doc, lc } of yamlDocs(src)) {
    const root = doc.contents;
    if (!root || !YAML.isMap(root)) continue;
    const kind = yScalar(yGet(root, 'kind')?.value);
    if (!kind || !yGet(root, 'apiVersion')) continue;
    const metaName = yScalar(yGet(yGet(root, 'metadata')?.value, 'name')?.value);
    if (kind === 'ConfigMap' || kind === 'Secret') {
      for (const key of ['data', 'stringData']) {
        const data = yGet(root, key);
        if (!data || !YAML.isMap(data.value)) continue;
        for (const it of data.value.items) {
          const k = String(it.key?.value ?? it.key);
          const line = yLine(lc, it.key);
          if (kind === 'Secret') env.push({ name: k, value: null, redacted: true, source: rel, line, scope: 'k8s' });
          else {
            const e = envEntry(k, yScalar(it.value), rel, line, 'k8s');
            if (e) env.push(e);
          }
        }
      }
      continue;
    }
    if (kind === 'Service') {
      const spec = yGet(root, 'spec')?.value;
      const ports = [];
      const pn = yGet(spec, 'ports');
      if (pn && YAML.isSeq(pn.value)) {
        for (const p of pn.value.items) {
          const port = yScalar(yGet(p, 'port')?.value);
          const tp = yScalar(yGet(p, 'targetPort')?.value);
          if (port) ports.push(tp ? `${port}:${tp}` : port);
        }
      }
      if (metaName) services.push({ name: metaName, ports, hostnames: [], source: rel, line: yLine(lc, root) });
      continue;
    }
    if (kind === 'Ingress') {
      const rules = yGet(yGet(root, 'spec')?.value, 'rules');
      if (rules && YAML.isSeq(rules.value)) {
        for (const r of rules.value.items) {
          const host = yScalar(yGet(r, 'host')?.value);
          if (!host) continue;
          const backends = new Set();
          YAML.visit(r, {
            Pair(_, pair) {
              if ((pair.key?.value ?? '') === 'service' && YAML.isMap(pair.value)) {
                const n = yScalar(yGet(pair.value, 'name')?.value);
                if (n) backends.add(n);
              }
              if ((pair.key?.value ?? '') === 'serviceName') {
                const n = yScalar(pair.value);
                if (n) backends.add(n);
              }
            },
          });
          for (const b of backends) services.push({ name: b, ports: [], hostnames: [host], source: rel, line: yLine(lc, r) });
        }
      }
      continue;
    }
    // workloads: containers anywhere below spec
    const ports = [];
    YAML.visit(root, {
      Pair(_, pair) {
        const key = pair.key?.value ?? '';
        if ((key === 'containers' || key === 'initContainers') && YAML.isSeq(pair.value)) {
          for (const c of pair.value.items) {
            const envNode = yGet(c, 'env');
            if (envNode && YAML.isSeq(envNode.value)) {
              for (const ev of envNode.value.items) {
                const n = yScalar(yGet(ev, 'name')?.value);
                const vNode = yGet(ev, 'value');
                if (!n || !vNode) continue;
                const e = envEntry(n, yScalar(vNode.value), rel, yLine(lc, ev), 'k8s');
                if (e) env.push(e);
              }
            }
            const pn = yGet(c, 'ports');
            if (pn && YAML.isSeq(pn.value)) for (const p of pn.value.items) {
              const cp = yScalar(yGet(p, 'containerPort')?.value);
              if (cp) ports.push(cp);
            }
          }
        }
      },
    });
    if (metaName && ports.length) services.push({ name: metaName, ports, hostnames: [], source: rel, line: yLine(lc, root) });
  }
}

function extractHelmValues(rel, src, env) {
  for (const { doc, lc } of yamlDocs(src)) {
    const walk = (node, prefix) => {
      if (YAML.isMap(node)) {
        for (const it of node.items) {
          const k = String(it.key?.value ?? it.key);
          const name = prefix ? `${prefix}.${k}` : k;
          if (YAML.isScalar(it.value)) {
            const e = envEntry(name, yScalar(it.value), rel, yLine(lc, it.key), 'helm');
            if (e && !e.internalOnly) env.push(e);
          } else walk(it.value, name);
        }
      }
    };
    walk(doc.contents, '');
  }
}

function extractDockerfile(rel, src, env, services, memberName) {
  const lines = src.split(/\r?\n/);
  const exposed = [];
  let exposeLine = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let j = i;
    while (/\\\s*$/.test(line) && j + 1 < lines.length) {
      line = line.replace(/\\\s*$/, ' ') + lines[++j];
    }
    const m = /^\s*(ARG|ENV|EXPOSE)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const kw = m[1].toUpperCase();
    const rest = m[2].trim();
    if (kw === 'EXPOSE') {
      for (const p of rest.split(/\s+/)) if (p) exposed.push(p.replace(/\/tcp$/i, ''));
      exposeLine = exposeLine || i + 1;
      continue;
    }
    const pairs = [];
    if (kw === 'ENV' && !rest.includes('=')) {
      const sp = rest.split(/\s+/);
      pairs.push([sp[0], sp.slice(1).join(' ')]);
    } else {
      const re = /([A-Za-z_][\w.-]*)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?/g;
      let mm;
      while ((mm = re.exec(rest))) {
        let v = mm[2];
        if (v !== undefined) v = v.replace(/^["']|["']$/g, '');
        pairs.push([mm[1], v === undefined ? null : v]);
      }
    }
    for (const [k, v] of pairs) {
      const e = envEntry(k, v, rel, i + 1, 'dockerfile');
      if (e && !e.internalOnly) env.push(e);
    }
  }
  if (exposed.length) {
    const dir = posix.dirname(rel);
    services.push({ name: dir === '.' ? memberName : posix.basename(dir), ports: exposed, hostnames: [], source: rel, line: exposeLine });
  }
}

function extractDotEnv(rel, src, env) {
  const scope = /\.(example|sample|template|dist)$/i.test(rel) ? 'env-example' : 'env';
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, '$2');
    else v = v.replace(/\s+#.*$/, '');
    const e = envEntry(m[1], v, rel, i + 1, scope);
    if (e) env.push(e);
  }
}

function extractAppSettings(rel, src, env) {
  let json;
  try {
    json = JSON.parse(stripJsonComments(src.replace(/^\uFEFF/, '')));
  } catch {
    return;
  }
  const lines = src.split(/\r?\n/);
  const findLine = (key, value) => {
    const kq = `"${key}"`;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(kq) && (value === null || lines[i].includes(String(value).slice(0, 20)) || true)) return i + 1;
    return 1;
  };
  const walk = (node, prefix) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        const name = prefix ? `${prefix}:${k}` : k;
        if (v !== null && typeof v === 'object') walk(v, name);
        else {
          const e = envEntry(name, v === null ? null : String(v), rel, findLine(k, v), 'appsettings');
          if (e && !e.internalOnly) env.push(e);
        }
      }
    }
  };
  walk(json, '');
}

function extractOpenApi(rel, src, providers) {
  if (!/^\s*["']?(openapi|swagger)["']?\s*:/m.test(src)) return;
  for (const { doc, lc } of yamlDocs(src)) {
    const root = doc.contents;
    if (!YAML.isMap(root)) continue;
    if (!yGet(root, 'openapi') && !yGet(root, 'swagger')) continue;
    let prefix = yScalar(yGet(root, 'basePath')?.value) || '';
    const servers = yGet(root, 'servers');
    if (!prefix && servers && YAML.isSeq(servers.value) && servers.value.items[0]) {
      const u = yScalar(yGet(servers.value.items[0], 'url')?.value);
      if (u) prefix = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    }
    const paths = yGet(root, 'paths');
    if (!paths || !YAML.isMap(paths.value)) continue;
    for (const p of paths.value.items) {
      const path = String(p.key?.value ?? p.key);
      if (!YAML.isMap(p.value)) continue;
      for (const op of p.value.items) {
        const method = String(op.key?.value ?? op.key).toUpperCase();
        if (!HTTP_VERBS.includes(method)) continue;
        const opId = yScalar(yGet(op.value, 'operationId')?.value);
        providers.push({ kind: 'http', method, route: normalizeRoute(joinRoute(prefix, path)), rawRoute: path, framework: 'openapi', file: rel, line: yLine(lc, op.key), ...(opId ? { symbol: opId } : {}), catchAll: false, order: 0 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sortBy(arr, keys) {
  return arr.sort((a, b) => {
    for (const k of keys) {
      const x = a[k] ?? '';
      const y = b[k] ?? '';
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function extractContracts(root, { includeTests = false } = {}) {
  root = resolve(root);
  let files = listFiles(root);
  let filter = null;
  if (core && core.createIgnoreFilter) {
    try {
      filter = core.createIgnoreFilter(root);
    } catch {
      filter = null;
    }
  }
  files = files.filter((f) => {
    if (/(^|\/)\.(ua|understand-anything)\//.test(f)) return false;
    if (filter && filter.isIgnored(f)) return false;
    return true;
  });
  files.sort();
  const member = new Member(root, files);
  const memberName = basename(root);

  const codeFiles = files.filter((f) => {
    if (!EXT_LANG[posix.extname(f).toLowerCase()]) return false;
    if (includeTests) return true;
    return !isTestPath(f) && !NON_CODE_DIRS_RE.test(f);
  });
  // member is resolution universe for imports: all code files (tests included for resolution only)
  member.files = files.filter((f) => !(!includeTests && (isTestPath(f) || NON_CODE_DIRS_RE.test(f))) || !EXT_LANG[posix.extname(f).toLowerCase()]);
  member.fileSet = new Set(member.files);

  // index all code files first (function names feed helper call detection)
  for (const f of codeFiles) member.ctx(f);

  const memberFlags = {
    codeqConsumer: codeFiles.some((f) => {
      const src = member.read(f);
      return src && /\bclaim_task\s*\(|ClaimTaskOptions|\/v1\/codeq\/tasks\/claim/.test(src);
    }),
  };

  const providers = [];
  const consumers = [];
  const msgs = { publish: [], subscribe: [] };
  const tables = { reads: [], writes: [] };
  const env = [];
  const services = [];

  for (const f of codeFiles) {
    const ctx = member.ctx(f);
    if (!ctx) continue;
    try {
      if (ctx.lang === 'cs') extractAspNet(ctx, providers);
      else if (ctx.lang === 'py') extractPython(ctx, providers);
      else if (ctx.lang === 'js') extractJsProviders(ctx, providers);
    } catch (err) {
      warn(`providers ${f}: ${err.message}`);
    }
    try {
      consumers.push(...extractConsumers(ctx));
    } catch (err) {
      warn(`consumers ${f}: ${err.message}`);
    }
    try {
      extractMessages(ctx, msgs, memberFlags);
    } catch (err) {
      warn(`messages ${f}: ${err.message}`);
    }
  }

  const testOk = (f) => includeTests || !isTestPath(f);
  for (const f of files) {
    if (!testOk(f)) continue;
    const lower = f.toLowerCase();
    const base = posix.basename(lower);
    const ext = posix.extname(lower);
    try {
      if (ext === '.sql' || (codeFiles.includes(f) && CODE_EXT_FOR_SQL.has(ext))) {
        extractTables(member, f, ext === '.sql' ? null : member.ctx(f), tables);
        continue;
      }
      if (CODE_EXT_FOR_SQL.has(ext)) continue;
      const isYaml = ext === '.yml' || ext === '.yaml';
      if (/^(docker-)?compose[^/]*\.ya?ml$/.test(base)) {
        const src = member.read(f);
        if (src) extractCompose(f, src, env, services);
        continue;
      }
      if (/^dockerfile([.-][\w.-]+)?$/.test(base) || ext === '.dockerfile' || /^[\w.-]+\.dockerfile$/.test(base)) {
        const src = member.read(f);
        if (src) extractDockerfile(f, src, env, services, memberName);
        continue;
      }
      if (/^\.env(\.[\w.-]+)?$/.test(base) || /\.env$/.test(base) || /\.env\.(example|sample|template|dist)$/.test(base)) {
        const src = member.read(f);
        if (src) extractDotEnv(f, src, env);
        continue;
      }
      if (/^appsettings(\.[\w.-]+)?\.json$/.test(base)) {
        const src = member.read(f);
        if (src) extractAppSettings(f, src, env);
        continue;
      }
      if (isYaml || ext === '.json') {
        if (NON_CODE_DIRS_RE.test(f) && !/openapi|swagger/.test(lower)) continue;
        const src = member.read(f);
        if (!src || src.length > 3_000_000) continue;
        if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(src)) {
          extractOpenApi(f, src, providers);
          continue;
        }
        if (!isYaml) continue;
        if (/^\s*apiVersion\s*:/m.test(src) && /^\s*kind\s*:/m.test(src)) extractK8s(f, src, env, services);
        else if (/^values[\w.-]*\.ya?ml$/.test(base) && member.fileSet.has(posix.join(posix.dirname(f), 'Chart.yaml'))) extractHelmValues(f, src, env);
      }
    } catch (err) {
      warn(`config ${f}: ${err.message}`);
    }
  }

  envChannels(env, msgs);
  const envOut = env.filter((e) => !e.internalOnly).map(({ rawValue: _r, internalOnly: _i, ...rest }) => rest);

  const provOut = sortBy(dedupe(providers, (p) => `${p.file}:${p.line}:${p.method}:${p.route}`), ['file', 'line', 'method', 'route']).map((p) => {
    const o = { kind: p.kind, method: p.method, route: p.route, rawRoute: p.rawRoute, framework: p.framework, file: p.file, line: p.line };
    if (p.symbol) o.symbol = p.symbol;
    o.catchAll = !!p.catchAll;
    o.order = p.order || 0;
    return o;
  });
  const consOut = sortBy(dedupe(consumers, (c) => `${c.file}:${c.line}:${c.method}:${c.path}:${c.via}`), ['file', 'line', 'method', 'path']);
  const msgOut = {
    publish: sortBy(dedupe(msgs.publish, (m) => `${m.channel}:${m.system}:${m.file}:${m.line}`), ['file', 'line', 'channel']),
    subscribe: sortBy(dedupe(msgs.subscribe, (m) => `${m.channel}:${m.system}:${m.file}:${m.line}`), ['file', 'line', 'channel']),
  };
  const tabOut = {
    reads: sortBy(dedupe(tables.reads, (t) => `${t.table}:${t.file}:${t.line}`), ['file', 'line', 'table']),
    writes: sortBy(dedupe(tables.writes, (t) => `${t.table}:${t.file}:${t.line}`), ['file', 'line', 'table']),
  };
  const envSorted = sortBy(dedupe(envOut, (e) => `${e.scope}:${e.source}:${e.line}:${e.name}`), ['source', 'line', 'name']);
  const svcOut = sortBy(dedupe(services, (s) => `${s.source}:${s.line}:${s.name}`), ['source', 'line', 'name']);

  return {
    version: 1,
    providers: provOut,
    consumers: consOut,
    messages: msgOut,
    tables: tabOut,
    env: envSorted,
    services: svcOut,
    stats: {
      providers: provOut.length,
      consumers: consOut.length,
      unresolvedConsumers: consOut.filter((c) => c.path === null || c.base.type === 'unknown').length,
      publish: msgOut.publish.length,
      subscribe: msgOut.subscribe.length,
      tableReads: tabOut.reads.length,
      tableWrites: tabOut.writes.length,
      env: envSorted.length,
      services: svcOut.length,
      filesScanned: codeFiles.length,
    },
  };
}

function uaDirOf(root) {
  if (core && core.resolveUaDir) {
    try {
      return core.resolveUaDir(root);
    } catch {
      /* fall through */
    }
  }
  const legacy = join(root, '.understand-anything');
  return existsSync(legacy) && statSync(legacy).isDirectory() ? legacy : join(root, '.ua');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) {
    process.stderr.write('Usage: node extract-contracts.mjs <memberRoot> [--out <file>] [--include-tests]\n');
    process.exit(2);
  }
  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    process.stderr.write(`extract-contracts: not a directory: ${args.root}\n`);
    process.exit(2);
  }
  if (!YAML) warn('yaml parser unavailable (build/install @understand-anything/core); compose/k8s/OpenAPI skipped');
  const result = extractContracts(args.root, { includeTests: args.includeTests });
  const out = args.out ? resolve(args.out) : join(uaDirOf(resolve(args.root)), 'contracts.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  const s = result.stats;
  process.stderr.write(
    `extract-contracts: ${s.providers} providers, ${s.consumers} consumers (${s.unresolvedConsumers} unresolved), ` +
      `${s.publish}/${s.subscribe} pub/sub, ${s.tableReads}/${s.tableWrites} table r/w, ${s.env} env, ${s.services} services → ${out}\n`,
  );
}

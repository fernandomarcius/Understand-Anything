# Multi-repo workspace

Analyze several repositories (typically microservices) as **one** knowledge graph, with the
same structural guarantees a monorepo gets: unique IDs, a single dashboard, per-repo
incremental updates, and a code viewer that can open files from every member.

Each member keeps its own `.ua/` directory and its own incremental pipeline. The workspace
graph is a deterministic, LLM-free merge of the member graphs.

## Manifest — `ua-workspace.json`

Placed at the workspace root (any directory; it does not need to be a git repository):

```json
{
  "name": "cloudbi",
  "members": [
    { "name": "brain", "path": "../CSF_CLOUDBI_BRAIN" },
    { "name": "motor", "path": "../CSF_CLOUDBI_MOTOR_CALCULO" }
  ]
}
```

Validation rules (violations are hard errors, exit code ≠ 0, message names the field):

| Field | Rule |
|---|---|
| `name` | required, `^[a-z0-9][a-z0-9-]*$` |
| `members` | required, non-empty array |
| `members[].name` | required, `^[a-z0-9][a-z0-9-]*$`, unique within the workspace |
| `members[].path` | required; relative paths resolve against the workspace root; must be an existing directory; two members may not resolve to the same directory, and a member may not contain another |

## Namespacing contract (member graph → workspace graph)

`M` = member name. Every rewrite is purely syntactic.

### Node IDs

| Node type (ID prefix) | Member ID | Workspace ID |
|---|---|---|
| path-based: `file`, `config`, `document`, `service`, `pipeline`, `schema`, `resource` | `file:src/a.ts` | `file:M/src/a.ts` |
| path + symbol: `function`, `class`, `table`, `endpoint` | `function:src/a.ts:run` | `function:M/src/a.ts:run` |
| name-based: `module`, `concept` | `module:auth` | `module:M/auth` |
| domain / knowledge / any other prefix | `domain:billing` | `domain:M/billing` |

General rule: an ID is `<prefix>:<rest>`; the workspace ID is `<prefix>:M/<rest>`. Split on
the **first** `:` only, so symbol suffixes such as `:Type.method` are preserved. IDs without
a `:` become `M/<id>`.

### Other fields

- `node.filePath` → `M/<filePath>` (absent/empty stays absent/empty).
- `edge.source` / `edge.target` → rewritten with the node rule above. Edges whose endpoints
  are missing after rewrite are dropped and reported.
- `layer.id` `layer:x` → `layer:M/x`; `layer.name` → `"<M> · <name>"`; `layer.nodeIds` rewritten.
- `tour`: member tours are concatenated in manifest order. Each member contributes a leading
  step `{ title: "<M>", description: <member project.description>, nodeIds: [] }` followed by
  its own steps (with `nodeIds` rewritten). `order` is renumbered `1..N` across the result.
  A workspace-level tour (across services), when present, goes before them — see "Workspace tour".
- Nothing else in nodes/edges is modified (summaries, tags, weights, complexity, extra keys).

### Project metadata

```jsonc
"project": {
  "name": "<workspace name>",
  "languages": [/* sorted union of member languages */],
  "frameworks": [/* sorted union of member frameworks */],
  "description": "Workspace of N services: m1, m2, …",
  "analyzedAt": "<ISO timestamp of the merge>",
  "gitCommitHash": "ws:<sha1 hex of the sorted lines 'name@gitCommitHash'>",
  "workspace": {
    "name": "<workspace name>",
    "members": [
      {
        "name": "brain",
        "path": "../CSF_CLOUDBI_BRAIN",          // as written in the manifest
        "gitCommitHash": "<member project.gitCommitHash>",
        "analyzedAt": "<member project.analyzedAt>",
        "nodes": 123,                              // member node count
        "edges": 456                               // member edge count
      }
    ]
  }
}
```

`gitCommitHash` is deterministic: same member hashes ⇒ same value, independent of manifest order.

Graph-level `kind` is `codebase`. `version` is copied from the first member.

## Outputs

`merge-workspace-graphs.py <workspace-root>` (in `skills/understand/`):

- reads `ua-workspace.json` and each member's `<member>/.ua/knowledge-graph.json`
  (or legacy `.understand-anything/`), honoring the same data-dir rule as everywhere else;
- writes `<workspace-root>/.ua/knowledge-graph.json` and `<workspace-root>/.ua/meta.json`
  (`{ lastAnalyzedAt, gitCommitHash, version, analyzedFiles, workspace: true }`, where
  `analyzedFiles` is the number of file-level nodes);
- copies the first member's `outputLanguage` into `<workspace-root>/.ua/config.json` unless
  that file already sets one (so the dashboard renders in the analysis language);
- prints a one-line summary per member and a total to stdout; warnings to stderr;
- exits non-zero (and writes nothing) when the manifest is invalid or a member graph is missing
  or unparsable — the error names the member and the expected path.

`merge-workspace-graphs.py <workspace-root> --validate-only` checks the manifest only (member
graphs are not read, nothing is written) and prints
`{"name", "members": [{"name", "path", "dir"}]}` to stdout, `dir` being the resolved absolute
member directory. The skill runs it before any member pipeline.

Invariant checked by the script before writing: the number of workspace nodes equals the sum of
member node counts (namespacing makes collisions impossible; a mismatch is a bug → exit ≠ 0).
With contracts linked it becomes `sum(members[].nodes) + project.workspace.contracts.nodes`.

Final validation, also before writing (`validate_workspace_graph`, same rules as the plugin's
inline validator in `SKILL.md`): no duplicate node or layer ids, no dangling edges, every
`layers[].nodeIds` / `tour[].nodeIds` entry exists, and every node of a file-level type
(`file config document service pipeline table schema resource endpoint`) sits in exactly one
layer. Any violation — including one inherited from a member graph — exits ≠ 0 listing the issues
(first 20) and writes nothing; previous outputs stay untouched. Member-dangling edges are dropped
by the merge (see above), so they never reach this check.

## Dashboard / viewer

The graph's `project.workspace` is the source of truth; the dashboard server never reads the
manifest.

- `/file-content.json?path=M/rel/path`: the first path segment selects member `M`; the file is
  resolved as `<dir containing .ua>/<members[M].path>/rel/path`. It must stay inside that member
  root after resolution (`..`, absolute paths and symlink escapes → 403), `M` must be a declared
  member (else 403), and `M/rel/path` must be a `filePath` present in the graph (existing
  allowlist rule). Non-workspace graphs behave exactly as before.
- Freshness: for workspace graphs, staleness is computed per member
  (`git rev-parse HEAD` in each member path vs `members[].gitCommitHash`). The banner lists the
  stale member names. A member that is not a git repository is reported as "unknown", never stale.

  Both servers call core `getWorkspaceFreshness(<dir containing .ua>, graph)` (in
  `packages/core/src/staleness.ts`; it returns `null` for a non-workspace graph) and add its result
  as `workspace` to the `/staleness.json` payload. `graphs.knowledge` (and `graphs.domain`) are
  still computed as before and stay mandatory — for a workspace root that is not a git repository
  `graphs.knowledge` is simply `unknown`:

  ```jsonc
  {
    "graphs": { "knowledge": GraphFreshnessResult, "domain"?: GraphFreshnessResult },
    "workspace"?: {                       // only for workspace graphs
      "name": "cloudbi",
      "members": [                        // manifest order
        { "name": "brain", "path": "../brain", "status": "fresh", "graphCommitHash": "…", "headCommitHash": "…" },
        { "name": "motor", "path": "../motor", "status": "stale", "graphCommitHash": "…", "headCommitHash": "…" },
        { "name": "docs",  "path": "../docs",  "status": "unknown", "graphCommitHash": "…",
          "reason": "missing-graph-commit" | "member-path-missing" | "git-head-unavailable" | "git-command-timeout" }
      ]
    }
  }
  ```

  Malformed member entries in the graph are dropped before the check (same rule as
  `/file-content.json`); a non-string `gitCommitHash` is reported as `missing-graph-commit`. When
  `workspace` is present the banner ignores `graphs`, lists stale members by name and mentions the
  unverifiable ones softly. The client validator (`isDashboardFreshnessReport`) rejects a malformed
  `workspace` block, and the whole payload is then treated as a failed request.

  `staleness.ts` only imports Node builtins at runtime, so the packaged viewer keeps working with
  the copy its `build.mjs` places at `bin/dist/staleness.js`.

Both `packages/dashboard/vite.config.ts` and `packages/viewer/bin/viewer.mjs` implement this
(they are kept in sync by design).

## Skill flow — `/understand --workspace [dir]`

1. Resolve the workspace root (`dir` or cwd) and validate the manifest
   (`merge-workspace-graphs.py <root> --validate-only`).
2. For each member in order: run the normal `/understand` pipeline with `PROJECT_ROOT=<member>`
   (its own `.ua/`, incremental by default, `--language`, `--exclude` and `--full` forwarded). Members whose
   `meta.json.gitCommitHash` equals their current `HEAD` and that have a graph are skipped
   without any LLM call.
3. Run `merge-workspace-graphs.py <root>` (merge + contract linking + validation; `--no-contracts` skips linking).
4. Workspace tour (see below): when `crossServiceLinks > 0`, dispatch `tour-builder` on
   `workspace-tour-input.json` and re-run the merge; otherwise skip.
5. Launch the dashboard on the workspace root.

## Workspace tour

The member tours explain each service; the workspace tour explains the **system** — one request
followed across services (e.g. UI → API → queue → worker → data). Two deterministic ends around
one LLM step:

1. **Input** (every successful merge, after linking): `<root>/.ua/intermediate/workspace-tour-input.json`

   ```jsonc
   {
     "version": 1, "workspace": "cloudbi", "outputLanguage": "pt-BR",   // workspace config, else first member's
     "crossServiceLinks": 14,             // sum of the link counts below; 0 ⇒ the skill skips the tour
     "members": [{ "name", "description", "languages", "frameworks", "files",          // file-level nodes
                   "topLayers": [{ "id", "name", "nodes" }],                           // ≤ 5, largest first
                   "tourStart": ["file:front/src/index.js"] }],                       // member tour step 1
     "services": { "links": [{ "source", "target", "calls", "messages", "tables" }] }, // = dashboard Services view
     "contracts": {                       // ≤ 10 each, most members first; sides are [{ member, nodeId }]
       "endpoints": [{ "id", "name", "member", "providers", "consumers", "consumerMembers" }],
       "channels":  [{ "id", "name", "publishers", "subscribers" }],
       "tables":    [{ "id", "name", "writers", "readers" }]
     },
     "nodes": { "<id>": { "type", "name", "member", "summary" } }   // every id cited above, and only those
   }
   ```

   `services.links` reimplements core `buildServiceGraph` (cross-member `calls`; publisher → subscriber
   per shared channel; shared table writer → reader, else manifest order). Endpoints count only
   `calls` from another member. Output is byte-identical for the same inputs.
2. **Narrative** (LLM, skill only): `tour-builder` reads the input and writes
   `<root>/.ua/workspace-tour.json` — an array of 5–10 `{ title, description, nodeIds, languageLesson? }`
   citing only ids from `nodes`; a step that crosses a contract cites nodes from ≥ 2 services.
3. **Placement** (every merge): when `workspace-tour.json` exists, its steps (sorted by `order` if given;
   a `{ "steps": [...] }` envelope is accepted; steps without `title` are skipped) go **first** in
   `tour`, before the per-member tours. Node ids absent from the graph are dropped with one warning
   each, and `order` is renumbered `1..N`. An unparsable file is ignored with a warning; without the
   file the tour is unchanged. Re-running `link-contracts.py` keeps tour references to contract
   nodes it re-creates.

---

# Cross-service contracts (stage 2 / 2b / 3)

Monorepos get cross-module edges from a deterministic import resolver. Services talk over HTTP,
queues and shared tables instead, so the workspace gets an equivalent **deterministic contract
linker**: extract what each member *provides* and *consumes*, resolve where each consumer points,
and link them. No LLM is involved; every link carries evidence and a confidence.

## Per-member extraction — `extract-contracts.mjs <memberRoot> [--out <file>]`

Writes `<memberRoot>/.ua/contracts.json` (data dir rule applies). Runs on files tracked by git
(`git ls-files`), honoring `.understandignore`. Schema (`version: 1`):

```jsonc
{
  "version": 1,
  "providers": [            // HTTP routes this member exposes
    { "kind": "http", "method": "GET", "route": "/api/Operacoes/elegiveis",   // composed, normalized (see below)
      "rawRoute": "elegiveis", "framework": "aspnet|fastapi|flask|express|nestjs|http.server|openapi",
      "file": "API/Controllers/OperacoesController.cs", "line": 68,
      "symbol": "OperacoesController.Elegiveis",          // optional
      "catchAll": false, "order": 0 }                      // ASP.NET {**x} catch-all + Order
  ],
  "consumers": [            // outbound HTTP calls
    { "kind": "http", "method": "GET", "path": "/Operacoes/elegiveis",        // path relative to the base, template-normalized; may be null if unknown
      "base": { "type": "env|config|literal|unknown", "name": "REACT_APP_API_GESTAO_OPERACAO", "value": null, "suffix": "" },
      "via": "superagent-wrapper|axios|axios.create|fetch|requests|httpx|HttpClient|typed-client|helper",
      "file": "src/api/operacaoApi.js", "line": 17, "confidence": 0.9 }
  ],
  "messages": {             // stage 2b — queues / topics / commands
    "publish":   [ { "channel": "brain-relatorio-detalhado", "system": "codeq|kafka|rabbitmq|redis|unknown", "file": "...", "line": 1 } ],
    "subscribe": [ { "channel": "brain-relatorio-*",         "system": "codeq", "file": "...", "line": 1 } ]
  },
  "tables": {               // stage 2b — data coupling
    "reads":  [ { "table": "dbo.LOG_RESUMO", "file": "...", "line": 1 } ],
    "writes": [ { "table": "dbo.LOG_RESUMO", "file": "...", "line": 1 } ]
  },
  "env": [                  // stage 3 — configuration values found in deploy/config files
    { "name": "REACT_APP_API_GESTAO_OPERACAO", "value": "http://172.16.50.47:8082/api",
      "source": "docker-compose.yml", "line": 24, "scope": "compose|dockerfile|env-example|env|k8s|appsettings|helm" }
  ],
  "services": [             // stage 3 — what this member deploys and where it listens
    { "name": "gestao-operacao", "ports": ["8082:8080"], "hostnames": ["csfcloudbigestaooperacaodev.azurewebsites.net"],
      "source": "docker-compose.yml", "line": 13 }
  ],
  "stats": { "providers": 0, "consumers": 0, "unresolvedConsumers": 0 }
}
```

Secrets: env values that look like credentials (keys named `*KEY*`, `*SECRET*`, `*PASSWORD*`,
`*TOKEN*`, connection strings with `Password=`/`pwd=`, JWTs, PEM blocks) are **never** written;
store `"value": null, "redacted": true`. Only URL-like values (scheme://host[:port][/path]) and
bare host:port are kept.

### Route normalization (shared by providers and consumers)

- strip scheme/host; strip query string and fragment; collapse `//`; ensure leading `/`; drop trailing `/` (except root);
- template parameters become `{}`: `{id}`, `{id:int}`, `{**resto}` (catch-all, flagged), `:id`, `<int:id>`, `${expr}` (JS template), `{0}`/f-string `{x}`;
- matching is case-insensitive (ASP.NET is); the stored value keeps the original case.

### ASP.NET composition rules
Class `[Route]` + action template; `[controller]` = class name minus `Controller` (not the file name);
`[action]` = method name; leading `/` on an action template discards the class route; a template with
no class route is absolute; resolve `const string` used in attributes within the same file; honor an
`IApplicationModelConvention` that prepends a constant prefix to every controller of a folder/assembly
when it is statically recognizable; catch-alls keep `catchAll: true` and their `Order`.

## Linking — `link-contracts.py <workspaceRoot>` (run in memory by `merge-workspace-graphs.py` after the merge)

1. Load every member's `contracts.json` (missing file ⇒ that member contributes nothing; warn).
2. **Resolve each consumer's target member** in this order:
   1. manifest `bindings` (optional, explicit — wins): `"bindings": { "REACT_APP_API_MOTOR_CALCULO": "gestao:/api/motor" }` means
      "this base points to member `gestao`, with path prefix `/api/motor`". A binding to `"external:<label>"` marks it intentionally external.
   2. `env` values of the consumer's own member (and of the workspace manifest's optional `env` map) → URL → host:port/hostname
      → member whose `services` publish that port/hostname (or whose `services[].name` equals the host).
      `base.suffix` / path segments embedded in the env value are prepended to the consumer path.
   3. otherwise ⇒ `unresolved`.
3. **Match** the (method, prefix + path) against the target member's providers using the normalized form.
   Literal routes beat templated ones; templated beat catch-alls; ties keep the first by file order. A method
   mismatch with an exact path is reported, not linked.
4. **Emit into the workspace graph** (namespaced ids):
   - an `endpoint` node per matched provider route (id `endpoint:<M>/<file>:<METHOD> <route>`) and a `routes`
     edge from the provider file node to it (existing edge type; no new types are introduced);
   - a `calls` edge from the consumer file node to the endpoint node, with `crossService: true`, `confidence`,
     and `evidence: { consumer: "M/file:line", provider: "N/file:line", via, base }`;
   - messages: `publishes` (publisher file → `concept:<system>/<channel>` node) and `subscribes` (consumer file → same node);
     glob subscriptions (`brain-relatorio-*`) match concrete channels;
   - tables: `writes_to` / `reads_from` between file nodes and a shared `table:workspace/<schema.table>` node, only when
     ≥ 2 members touch the same table.
5. Write `<workspaceRoot>/.ua/contracts-report.json`: per member pair counts, resolved/unresolved/unmatched consumers with
   reasons (`no-binding`, `external`, `no-route`, `method-mismatch`), providers with zero consumers (possible dead endpoints),
   and coverage `linked / (consumers with a non-external target)`.

The linker is idempotent: re-running it on the same inputs yields byte-identical output.

### Linker details

- **Invocation.** `merge-workspace-graphs.py` links in memory (`link_workspace`) and validates the
  result before writing graph, meta and report together. `link-contracts.py <root>` re-links an
  already merged graph on disk with the same validation. `merge-workspace-graphs.py --no-contracts`
  skips linking: the graph is rebuilt from the member graphs, so it carries no linker node, edge or
  layer and no `project.workspace.contracts`, and a stale `.ua/contracts-report.json` is deleted.
- **`generatedBy: "link-contracts"`** marks every node and edge the linker creates. A re-run removes
  them (plus the contracts layer) before linking again. Pre-existing member nodes are reused, never
  marked or moved — e.g. an endpoint the member analysis already produced keeps its member layer.
- **`project.workspace.contracts`** = `{ "nodes": <added>, "edges": <added> }` (counts of
  `generatedBy` items; `0/0` when nothing linked).
- **Contracts layer.** Every node the linker creates (`endpoint`, shared `table`, channel `concept`)
  goes into `layer:workspace/contratos` ("Contratos entre serviços", with a description),
  `nodeIds` sorted. Rebuilt on each run; omitted when the linker creates no node.
- **Confidence** of a `calls` edge = `consumer.confidence` (default `1.0` when absent or outside
  `(0, 1]`) × match factor (literal `1.0`, templated `0.9`, catch-all `0.5`) × resolution factor
  (`binding` / manifest `env` `1.0`, member env / base literal `0.9`), rounded to 3 decimals. Several
  call sites of the same file→endpoint pair share one edge: `callSites` counts them and the edge
  keeps the highest confidence. Fixed weights: `routes` 1.0, `publishes`/`subscribes` 0.9,
  `writes_to`/`reads_from` 0.8.
- **Precedence.** Target: manifest `bindings` → manifest `env` → member `env` → `base.value`
  literal; within values, host/service name/hostname beats published port, and a host or port
  served by ≥ 2 members is reported ambiguous (unresolved). Route: literal → templated → catch-all,
  then lower `order`, then first by (file, line). The best route whose method fits wins; if only
  other-method routes match, the consumer is `method-mismatch`.
- **`ANY` method.** A provider method `ANY`, `*` or empty accepts every consumer method; a consumer
  without a method matches any provider method. Endpoint ids and names print a missing method as `ANY`.

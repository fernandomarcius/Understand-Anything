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
  A workspace-level tour (across services) is a later stage.
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
3. Run `merge-workspace-graphs.py <root>`.
4. Launch the dashboard on the workspace root.

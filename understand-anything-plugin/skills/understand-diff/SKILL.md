---
name: understand-diff
description: Use when you need to analyze git diffs or pull requests to understand what changed, affected components, and risks
---

# /understand-diff

Analyze the current code changes against the knowledge graph in the project's data directory (`.ua/knowledge-graph.json`, or the legacy `.understand-anything/knowledge-graph.json` when that directory is present).

## Graph Structure Reference

The knowledge graph JSON has this structure:
- `project` — {name, description, languages, frameworks, analyzedAt, gitCommitHash}
- `nodes[]` — each has {id, type, name, filePath?, summary, tags[], complexity, languageNotes?}
  - Code node types: file, function, class, module, concept
  - Non-code node types: config, document, service, table, endpoint, pipeline, schema, resource
  - Domain/knowledge node types: domain, flow, step, article, entity, topic, claim, source
  - IDs use the node type as prefix, e.g. `file:path`, `function:path:name`, `config:path`, `article:path`
- `edges[]` — each has {source, target, type, direction, weight}
  - Key types: imports, contains, calls, depends_on, configures, documents, deploys, triggers, contains_flow, flow_step, related, cites
- `layers[]` — each has {id, name, description, nodeIds[]}
- `tour[]` — each has {order, title, description, nodeIds[]}

## How to Read Efficiently

1. Use Grep to search within the JSON for relevant entries BEFORE reading the full file
2. Only read sections you need — don't dump the entire graph into context
3. Node names and summaries are the most useful fields for understanding
4. Edges tell you how components connect — follow imports and calls for dependency chains

## Workspace mode (multi-repo graphs)

When the graph's `project` section has a `workspace` block (a graph merged by
`/understand --workspace`, see `docs/multi-repo-workspace.md`), node ids and
`filePath`s are namespaced per member: `file:<M>/<path>`, `filePath: "<M>/<path>"`.
The workspace root is usually not a git repository, so the diff comes from each
member instead. Follow the normal instructions below with these changes:

1. **Members** — read `project.workspace.members[]` (`name`, `path` relative to the
   workspace root). The user may restrict the analysis to one member (`/understand-diff <member>`).
2. **Changed files per member** — run git *inside each member root*, never at the workspace root:
   ```bash
   git -C "<workspaceRoot>/<member.path>" diff --name-status -M <base>...HEAD
   git -C "<workspaceRoot>/<member.path>" diff --name-only
   git -C "<workspaceRoot>/<member.path>" diff --cached --name-only
   ```
   Paths are relative to that member. For renames/deletions (`R`/`D` in `--name-status`)
   keep the **old** path too: it is how an endpoint whose route moved away is found.
   Freshness (step 3) is per member: compare `git -C <member> rev-parse HEAD` with
   `members[].gitCommitHash`, and warn per stale member.
3. **Map to graph ids** — prefix every path with its member: `<M>/<path>` is the `filePath`
   to grep; node ids are `<type>:<M>/<path>[:symbol]`. Never match a bare path across members.
4. **Cross-service impact (deterministic)** — write the changes to a temp file as
   `{ "<member>": ["path", ...] }` and run, from the plugin root:
   ```bash
   node skills/understand-diff/cross-service-impact.mjs "<workspaceRoot>" --changes <changes.json> --overlay --base <base>
   ```
   It prints a `## Cross-Service Impact` section: endpoints whose provider file changed with
   their consumers in OTHER members (`M/file:line` evidence, `via`, confidence), calls from
   changed files into other services, message channels (`concept:<system>/<channel>`) and
   shared tables (`table:workspace/<schema.table>`) touched with the other services on them.
   `--overlay` writes `$UA_DIR/diff-overlay.json` (step 8) with `"workspace": true` and
   `crossServiceNodeIds` (also included in `affectedNodeIds`), so do not write it by hand.
   Use `--json` instead of Markdown when you need the raw structure.
5. **Report** — add a section "Cross-Service Impact" (written in the user's language, e.g.
   "Impacto entre serviços") right after "Affected Layers": per affected endpoint, list the
   consumer files in other services with `file:line`; then channels and tables touched; and
   name every other service that must be re-tested. Treat consumers with confidence < 0.7 as
   "probable". In the Risk Assessment, a non-empty cross-service impact is always a risk item.

## Instructions

1. **Resolve the data directory `$UA_DIR`.** Run `UA_DIR=$([ -d .understand-anything ] && echo .understand-anything || echo .ua)` — this is the legacy `.understand-anything/` when it already exists, otherwise the new `.ua/`. Check that `$UA_DIR/knowledge-graph.json` exists. If not, tell the user to run `/understand` first.

2. **Get the changed files list** (do NOT read the graph yet):
   - If on a branch with uncommitted changes: `git diff --name-only`
   - If on a feature branch: `git diff main...HEAD --name-only` (or the base branch)
   - If the user specifies a PR number: get the diff from that PR

3. **Read project metadata and check graph freshness** — use Grep or Read with a line limit to extract the `"project"` section, including `gitCommitHash` as `GRAPH_COMMIT_RAW`, then:
   - Resolve it as a commit before using it in any Git diff. From the project root, compare the resolved commit with `git rev-parse HEAD` and inspect project-scoped committed and working-tree changes:
     ```bash
     GRAPH_COMMIT=$(git rev-parse --verify --end-of-options "${GRAPH_COMMIT_RAW}^{commit}" 2>/dev/null)
     git rev-parse HEAD
     git diff --name-only "$GRAPH_COMMIT" HEAD -- .
     git diff --cached --name-only -- .
     git diff --name-only -- .
     git ls-files --others --exclude-standard -- .
     ```
   - The `-- .` pathspec is required: commits that only touch a sibling monorepo project must not make this graph stale. A hash mismatch alone is not stale when the project diff is empty.
   - Ignore the selected data directory (`.ua/` or legacy `.understand-anything/`) in every command's output because it contains generated graph artifacts, not project source drift.
   - If the committed diff or any working-tree command reports project files, warn before impact analysis that the graph may omit those changes. Suggest: Run `/understand` to refresh the graph.
   - Run the commit diff only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.

4. **Find nodes for changed files** — for each changed file path, use Grep to search the knowledge graph for:
   - Nodes with matching `"filePath"` values (e.g., `grep "changed/file/path"`)
   - This finds file-level nodes (including non-code types) AND function/class nodes defined in those files
   - Note the `id` values of all matched nodes

5. **Find connected edges (1-hop)** — for each matched node ID, Grep for that ID in the edges to find:
   - What imports or depends on the changed nodes (upstream callers)
   - What the changed nodes import or call (downstream dependencies)
   - These are the "affected components" — things that might break or need updating

6. **Identify affected layers** — Grep for the matched node IDs in the `"layers"` section to determine which architectural layers are touched.

7. **Provide structured analysis**:
   - **Changed Components**: What was directly modified (with summaries from matched nodes)
   - **Affected Components**: What might be impacted (from 1-hop edges)
   - **Affected Layers**: Which architectural layers are touched and cross-layer concerns
   - **Risk Assessment**: Based on node `complexity` values, number of cross-layer edges, and blast radius (number of affected components)
   - Suggest what to review carefully and any potential issues

8. **Write diff overlay for dashboard** — after producing the analysis, write the diff data to `$UA_DIR/diff-overlay.json` so the dashboard can visualize changed and affected components. The file contains:
   ```json
   {
     "version": "1.0.0",
     "baseBranch": "<the base branch used>",
     "generatedAt": "<ISO timestamp>",
     "changedFiles": ["<list of changed file paths>"],
     "changedNodeIds": ["<node IDs from step 4>"],
     "affectedNodeIds": ["<node IDs from step 5, excluding changedNodeIds>"]
   }
   ```
   In workspace mode the overlay is produced by `cross-service-impact.mjs --overlay` (Workspace mode, step 4); it adds `"workspace": true` and `"crossServiceNodeIds"` (consumers in other services, highlighted separately by the dashboard).
   After writing, tell the user they can run `/understand-anything:understand-dashboard` to see the diff overlay visually.

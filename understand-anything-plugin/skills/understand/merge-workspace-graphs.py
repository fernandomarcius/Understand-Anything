#!/usr/bin/env python3
"""
merge-workspace-graphs.py — Merge the knowledge graphs of several repositories
(the members of a multi-repo workspace) into one workspace graph.

Reads `<workspace-root>/ua-workspace.json`, validates it, loads each member's
`<member>/.ua/knowledge-graph.json` (or legacy `.understand-anything/` when that
directory already exists) and namespaces every member graph under its member
name so IDs can never collide. The merge is deterministic and LLM-free; the
contract lives in docs/multi-repo-workspace.md.

Usage:
    python merge-workspace-graphs.py <workspace-root> [--no-contracts]
    python merge-workspace-graphs.py <workspace-root> --validate-only

`--validate-only` checks the manifest only (member graphs are not read, nothing
is written) and prints `{"name", "members": [{"name", "path", "dir"}]}` as JSON
to stdout, `dir` being the resolved absolute member directory. The
`/understand --workspace` skill uses it before running the member pipelines.

After a successful merge it runs link-contracts.py (cross-service contracts:
HTTP calls, message channels, shared tables) unless `--no-contracts` is given.
The manifest may carry optional `bindings` ({ ENV: "member[:/prefix]" |
"external:<label>" }) and `env` ({ ENV: "url" }) maps for that linker.

Output:
    <ua-dir>/knowledge-graph.json   merged workspace graph
    <ua-dir>/meta.json              { lastAnalyzedAt, gitCommitHash, version,
                                      analyzedFiles, workspace: true }
    <ua-dir>/config.json            first member's outputLanguage, only when
                                    the workspace config does not set one

Exits non-zero and writes nothing when the manifest is invalid, a member graph
is missing or unparsable, or the node-count invariant does not hold.
"""

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_NAME = "ua-workspace.json"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# Node types that represent one analyzed file (counted as `analyzedFiles`).
FILE_LEVEL_TYPES = {"file", "config", "document", "service", "pipeline", "schema", "resource"}


class WorkspaceError(Exception):
    """Fatal workspace problem: report it, exit non-zero, write nothing."""


def resolve_ua_dir(root: Path) -> Path:
    """Mirror core resolveUaDir: legacy .understand-anything/ wins if present."""
    legacy = root / ".understand-anything"
    return legacy if legacy.is_dir() else root / ".ua"


# ── Manifest ────────────────────────────────────────────────────────────────

def validate_manifest(root: Path, manifest: Any) -> tuple[str, list[dict[str, Any]]]:
    """Validate a parsed manifest.

    Returns (workspace_name, members) where each member is
    {"name", "path" (as written), "dir" (resolved Path)}.
    Raises WorkspaceError naming the offending field.
    """
    if not isinstance(manifest, dict):
        raise WorkspaceError(f"{MANIFEST_NAME}: top level must be a JSON object")

    name = manifest.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise WorkspaceError(f"{MANIFEST_NAME}: field 'name' must match {NAME_RE.pattern} (got {name!r})")

    raw_members = manifest.get("members")
    if not isinstance(raw_members, list) or not raw_members:
        raise WorkspaceError(f"{MANIFEST_NAME}: field 'members' must be a non-empty array")

    members: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for i, m in enumerate(raw_members):
        if not isinstance(m, dict):
            raise WorkspaceError(f"{MANIFEST_NAME}: members[{i}] must be an object")
        mname = m.get("name")
        if not isinstance(mname, str) or not NAME_RE.match(mname):
            raise WorkspaceError(
                f"{MANIFEST_NAME}: members[{i}].name must match {NAME_RE.pattern} (got {mname!r})")
        if mname in seen_names:
            raise WorkspaceError(f"{MANIFEST_NAME}: members[{i}].name '{mname}' is a duplicate")
        seen_names.add(mname)

        mpath = m.get("path")
        if not isinstance(mpath, str) or not mpath:
            raise WorkspaceError(f"{MANIFEST_NAME}: members[{i}].path is required (member '{mname}')")
        mdir = (root / mpath).resolve()
        if not mdir.is_dir():
            raise WorkspaceError(
                f"{MANIFEST_NAME}: members[{i}].path '{mpath}' is not an existing directory "
                f"(member '{mname}', resolved to {mdir})")
        for other in members:
            odir = other["dir"]
            if mdir == odir:
                raise WorkspaceError(
                    f"{MANIFEST_NAME}: members[{i}].path '{mpath}' resolves to the same directory "
                    f"as member '{other['name']}' ({mdir})")
            if mdir.is_relative_to(odir) or odir.is_relative_to(mdir):
                raise WorkspaceError(
                    f"{MANIFEST_NAME}: members[{i}].path '{mpath}' and member '{other['name']}' "
                    f"are nested ({mdir} / {odir})")
        members.append({"name": mname, "path": mpath, "dir": mdir})

    validate_bindings(manifest.get("bindings"), {m["name"] for m in members})
    validate_env(manifest.get("env"))
    return name, members


def parse_binding(value: str) -> tuple[str, str, str]:
    """`"member[:/prefix]"` → ("member", name, prefix); `"external:<label>"` → ("external", label, "")."""
    if value.startswith("external:"):
        return "external", value[len("external:"):], ""
    target, sep, prefix = value.partition(":")
    return "member", target, prefix if sep else ""


def validate_bindings(bindings: Any, member_names: set[str]) -> None:
    """Optional `{ ENV_NAME: "member[:/prefix]" | "external:<label>" }`; member must exist."""
    if bindings is None:
        return
    if not isinstance(bindings, dict):
        raise WorkspaceError(f"{MANIFEST_NAME}: field 'bindings' must be an object")
    for key, value in bindings.items():
        if not key:
            raise WorkspaceError(f"{MANIFEST_NAME}: field 'bindings' has an empty variable name")
        field = f"bindings.{key}"
        if not isinstance(value, str) or not value:
            raise WorkspaceError(
                f"{MANIFEST_NAME}: {field} must be \"member[:/prefix]\" or \"external:<label>\" (got {value!r})")
        kind, target, prefix = parse_binding(value)
        if kind == "external":
            if not target:
                raise WorkspaceError(f"{MANIFEST_NAME}: {field} needs a label after 'external:'")
            continue
        if target not in member_names:
            raise WorkspaceError(f"{MANIFEST_NAME}: {field} points to unknown member '{target}'")
        if ":" in value and not prefix.startswith("/"):
            raise WorkspaceError(
                f"{MANIFEST_NAME}: {field} path prefix must start with '/' (got {prefix!r})")


def validate_env(env: Any) -> None:
    """Optional `{ ENV_NAME: "url" }` — workspace-level values for consumer bases."""
    if env is None:
        return
    if not isinstance(env, dict):
        raise WorkspaceError(f"{MANIFEST_NAME}: field 'env' must be an object")
    for key, value in env.items():
        if not key:
            raise WorkspaceError(f"{MANIFEST_NAME}: field 'env' has an empty variable name")
        if not isinstance(value, str) or not value:
            raise WorkspaceError(f"{MANIFEST_NAME}: env.{key} must be a non-empty string (got {value!r})")


def load_manifest(root: Path) -> tuple[str, list[dict[str, Any]]]:
    path = root / MANIFEST_NAME
    if not path.is_file():
        raise WorkspaceError(f"{MANIFEST_NAME} not found at {path}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise WorkspaceError(f"{MANIFEST_NAME} at {path} is not valid JSON: {e}") from e
    return validate_manifest(root, manifest)


def load_member_graph(member: dict[str, Any]) -> dict[str, Any]:
    """Load a member's knowledge graph or raise WorkspaceError naming member and path."""
    graph_path = resolve_ua_dir(member["dir"]) / "knowledge-graph.json"
    if not graph_path.is_file():
        raise WorkspaceError(f"member '{member['name']}': graph not found, expected {graph_path}")
    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise WorkspaceError(f"member '{member['name']}': cannot parse {graph_path}: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) \
            or not isinstance(data.get("edges"), list):
        raise WorkspaceError(f"member '{member['name']}': {graph_path} is missing nodes or edges array")
    return data


def load_member_output_language(member: dict[str, Any]) -> str | None:
    config_path = resolve_ua_dir(member["dir"]) / "config.json"
    try:
        lang = json.loads(config_path.read_text(encoding="utf-8")).get("outputLanguage")
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    return lang if isinstance(lang, str) and lang else None


# ── Namespacing ─────────────────────────────────────────────────────────────

def namespace_id(member: str, nid: Any) -> Any:
    """`<prefix>:<rest>` → `<prefix>:M/<rest>` (split on the first ':'); no ':' → `M/<id>`."""
    if not isinstance(nid, str):
        return nid
    prefix, sep, rest = nid.partition(":")
    if not sep:
        return f"{member}/{nid}"
    return f"{prefix}:{member}/{rest}"


def _namespace_ids(member: str, ids: Any) -> Any:
    if not isinstance(ids, list):
        return ids
    return [namespace_id(member, i) for i in ids]


def namespace_graph(member: str, graph: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of `graph` with every ID, filePath, layer and tour step namespaced."""
    nodes = []
    for node in graph.get("nodes", []):
        n = dict(node)
        n["id"] = namespace_id(member, node.get("id"))
        fp = node.get("filePath")
        if isinstance(fp, str) and fp:
            n["filePath"] = f"{member}/{fp}"
        nodes.append(n)

    edges = []
    for edge in graph.get("edges", []):
        e = dict(edge)
        e["source"] = namespace_id(member, edge.get("source"))
        e["target"] = namespace_id(member, edge.get("target"))
        edges.append(e)

    layers = []
    for layer in graph.get("layers", []) or []:
        if not isinstance(layer, dict):
            continue
        l = dict(layer)
        l["id"] = namespace_id(member, layer.get("id"))
        l["name"] = f"{member} · {layer.get('name', '')}"
        l["nodeIds"] = _namespace_ids(member, layer.get("nodeIds", []))
        layers.append(l)

    tour = []
    for step in graph.get("tour", []) or []:
        if not isinstance(step, dict):
            continue
        s = dict(step)
        s["nodeIds"] = _namespace_ids(member, step.get("nodeIds", []))
        tour.append(s)

    return {"nodes": nodes, "edges": edges, "layers": layers, "tour": tour}


def workspace_commit_hash(pairs: list[tuple[str, str]]) -> str:
    """`ws:` + sha1 of the sorted `name@gitCommitHash` lines (manifest-order independent)."""
    lines = sorted(f"{name}@{commit}" for name, commit in pairs)
    return "ws:" + hashlib.sha1("\n".join(lines).encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _str_list(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


# ── Merge ───────────────────────────────────────────────────────────────────

def merge_workspace(
    workspace_name: str,
    members: list[tuple[dict[str, Any], dict[str, Any]]],
) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
    """Merge (member, graph) pairs in manifest order.

    Returns (merged, report_lines, dropped_edges). Raises WorkspaceError when the
    node-count invariant (workspace nodes == sum of member nodes) does not hold.
    """
    report: list[str] = []
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    layers: list[dict[str, Any]] = []
    tour: list[dict[str, Any]] = []
    languages: set[str] = set()
    frameworks: set[str] = set()
    ws_members: list[dict[str, Any]] = []
    owner_by_id: dict[Any, str] = {}

    for member, graph in members:
        mname = member["name"]
        project = graph.get("project") if isinstance(graph.get("project"), dict) else {}
        ns = namespace_graph(mname, graph)

        for n in ns["nodes"]:
            nid = n.get("id")
            if nid in owner_by_id:
                raise WorkspaceError(
                    f"invariant broken: node id '{nid}' appears more than once "
                    f"(members '{owner_by_id[nid]}' and '{mname}')")
            owner_by_id[nid] = mname
        nodes.extend(ns["nodes"])
        edges.extend(ns["edges"])
        layers.extend(ns["layers"])
        description = project.get("description")
        tour.append({"title": mname,
                     "description": description if isinstance(description, str) else "",
                     "nodeIds": []})
        tour.extend(ns["tour"])

        languages.update(_str_list(project.get("languages")))
        frameworks.update(_str_list(project.get("frameworks")))
        ws_members.append({
            "name": mname,
            "path": member["path"],
            "gitCommitHash": project.get("gitCommitHash", ""),
            "analyzedAt": project.get("analyzedAt", ""),
            "nodes": len(graph.get("nodes", [])),
            "edges": len(graph.get("edges", [])),
        })

    expected = sum(m["nodes"] for m in ws_members)
    if len(nodes) != expected or len(owner_by_id) != expected:
        raise WorkspaceError(
            f"invariant broken: workspace has {len(owner_by_id)} unique nodes, members sum to {expected}")

    valid_edges: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for e in edges:
        missing = [f"{end} '{e.get(end)}'" for end in ("source", "target") if e.get(end) not in owner_by_id]
        if missing:
            dropped.append({**e, "missing": missing})
        else:
            valid_edges.append(e)
    for d in dropped:
        report.append(
            f"Warning: dropped edge {d.get('source')} -> {d.get('target')} "
            f"({d.get('type', '?')}): missing {', '.join(d['missing'])}")

    for i, step in enumerate(tour, start=1):
        step["order"] = i

    names = [m["name"] for m in ws_members]
    first_graph = members[0][1] if members else {}
    merged = {
        "version": first_graph.get("version", "1.0.0"),
        "kind": "codebase",
        "project": {
            "name": workspace_name,
            "languages": sorted(languages),
            "frameworks": sorted(frameworks),
            "description": f"Workspace of {len(names)} services: {', '.join(names)}",
            "analyzedAt": _now_iso(),
            "gitCommitHash": workspace_commit_hash(
                [(m["name"], str(m["gitCommitHash"])) for m in ws_members]),
            "workspace": {"name": workspace_name, "members": ws_members},
        },
        "nodes": nodes,
        "edges": valid_edges,
        "layers": layers,
        "tour": tour,
    }
    return merged, report, dropped


# ── Output ──────────────────────────────────────────────────────────────────

def _atomic_write_json(path: Path, data: Any) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def build_config(ua_dir: Path, output_language: str | None) -> dict[str, Any] | None:
    """Return the config to write, or None when config.json must stay untouched."""
    if not output_language:
        return None
    config_path = ua_dir / "config.json"
    config: dict[str, Any] = {}
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"Warning: {config_path} is not valid JSON, leaving it untouched: {e}", file=sys.stderr)
            return None
        if not isinstance(config, dict):
            print(f"Warning: {config_path} is not a JSON object, leaving it untouched", file=sys.stderr)
            return None
        if config.get("outputLanguage"):
            return None
    return {**config, "outputLanguage": output_language}


USAGE = "Usage: python merge-workspace-graphs.py <workspace-root> [--validate-only] [--no-contracts]"
FLAGS = {"--validate-only", "--no-contracts"}


def run_contract_linker(root: Path) -> int:
    """Run link-contracts.py (same directory) on the freshly merged workspace graph."""
    import importlib.util

    path = Path(__file__).resolve().with_name("link-contracts.py")
    spec = importlib.util.spec_from_file_location("_ua_link_contracts", path)
    if spec is None or spec.loader is None:
        print(f"Error: cannot load {path}", file=sys.stderr)
        return 1
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run(root)


def main() -> None:
    args = sys.argv[1:]
    validate_only = "--validate-only" in args
    no_contracts = "--no-contracts" in args
    positional = [a for a in args if a not in FLAGS]
    if len(positional) != 1 or positional[0].startswith("-"):
        print(USAGE, file=sys.stderr)
        sys.exit(1)

    root = Path(positional[0]).resolve()
    try:
        if not root.is_dir():
            raise WorkspaceError(f"workspace root {root} is not a directory")
        ws_name, members = load_manifest(root)
        if validate_only:
            print(json.dumps({
                "name": ws_name,
                "members": [{"name": m["name"], "path": m["path"], "dir": str(m["dir"])}
                            for m in members],
            }, indent=2))
            return
        loaded = [(m, load_member_graph(m)) for m in members]
        merged, report, _dropped = merge_workspace(ws_name, loaded)
    except WorkspaceError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    for line in report:
        print(line, file=sys.stderr)

    ua_dir = resolve_ua_dir(root)
    ua_dir.mkdir(parents=True, exist_ok=True)
    project = merged["project"]
    meta = {
        "lastAnalyzedAt": project["analyzedAt"],
        "gitCommitHash": project["gitCommitHash"],
        "version": merged["version"],
        "analyzedFiles": sum(1 for n in merged["nodes"] if n.get("type") in FILE_LEVEL_TYPES),
        "workspace": True,
    }
    config = build_config(ua_dir, load_member_output_language(members[0]))

    _atomic_write_json(ua_dir / "knowledge-graph.json", merged)
    _atomic_write_json(ua_dir / "meta.json", meta)
    if config is not None:
        _atomic_write_json(ua_dir / "config.json", config)

    for m in project["workspace"]["members"]:
        commit = str(m["gitCommitHash"])[:7] or "?"
        print(f"  {m['name']}: {m['nodes']} nodes, {m['edges']} edges @ {commit}")
    print(f"Workspace '{ws_name}' total: {len(merged['nodes'])} nodes, {len(merged['edges'])} edges, "
          f"{len(merged['layers'])} layers, {len(merged['tour'])} tour steps "
          f"({len(report)} dropped edges) -> {ua_dir / 'knowledge-graph.json'}")

    if not no_contracts:
        code = run_contract_linker(root)
        if code != 0:
            sys.exit(code)


if __name__ == "__main__":
    main()

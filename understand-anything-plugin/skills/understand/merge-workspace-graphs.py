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

After the merge it links cross-service contracts in memory (link-contracts.py:
HTTP calls, message channels, shared tables) unless `--no-contracts` is given,
then validates the final graph with the plugin's inline-validator rules
(`validate_workspace_graph`) before anything is written. The manifest may carry
optional `bindings` ({ ENV | origin: "member[:/prefix]" | "external:<label>" }, where an
origin key — `https://host[:port]` or a bare `host[:port]` — binds literal bases by host) and
`env` ({ ENV: "url" }) maps for that linker.

Output:
    <ua-dir>/knowledge-graph.json   merged workspace graph
    <ua-dir>/meta.json              { lastAnalyzedAt, gitCommitHash, version,
                                      analyzedFiles, workspace: true }
    <ua-dir>/config.json            first member's outputLanguage, only when
                                    the workspace config does not set one
    <ua-dir>/contracts-report.json  linker report; removed when `--no-contracts`
    <ua-dir>/intermediate/workspace-tour-input.json
                                    deterministic input for the workspace (system)
                                    tour: members, service links, top contracts

When `<ua-dir>/workspace-tour.json` exists (array of `{title, description,
nodeIds, languageLesson?}`, written by the tour-builder agent from that input),
its steps go first in `tour`, before the member tours; node ids missing from the
graph are dropped (one warning each) and `order` is renumbered 1..N.

Exits non-zero and writes nothing when the manifest is invalid, a member graph
is missing or unparsable, the node-count invariant does not hold or the final
graph fails validation (dangling edge, duplicate id, file-level node outside
exactly one layer, layer/tour referencing a missing node).
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

# Node types the plugin's inline validator (skills/understand/SKILL.md,
# `fileLevelTypes`) requires to sit in exactly one layer.
LAYERED_TYPES = FILE_LEVEL_TYPES | {"table", "endpoint"}

CONTRACTS_REPORT_NAME = "contracts-report.json"


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


_ORIGIN_URL_KEY_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9+.-]*://(?P<host>[A-Za-z0-9._-]+)(?::(?P<port>\d+))?/?$")
_ORIGIN_HOST_KEY_RE = re.compile(r"^(?P<host>[A-Za-z0-9._-]+)(?::(?P<port>\d+))?$")
DEFAULT_PORTS = {80, 443}


def binding_origin(key: Any) -> tuple[str, int | None] | None:
    """Binding key → (host lowercased, port|None) when it names an origin, else None.

    Origin keys are `scheme://host[:port][/]` (scheme ignored) or a bare `host[:port]`
    whose host has a dot or that carries a port (`storage.googleapis.com`,
    `localhost:8082`). Ports 80/443 count as "no port", so http/https keys and
    bases compare scheme-insensitively. Other keys are env names.
    """
    if not isinstance(key, str):
        return None
    m = _ORIGIN_URL_KEY_RE.match(key) if "://" in key else _ORIGIN_HOST_KEY_RE.match(key)
    if not m:
        return None
    host, port = m.group("host").lower(), m.group("port")
    if "://" not in key and not port and "." not in host:
        return None
    p = int(port) if port else None
    return host, None if p in DEFAULT_PORTS else p


def validate_bindings(bindings: Any, member_names: set[str]) -> None:
    """Optional `{ ENV_NAME | origin: "member[:/prefix]" | "external:<label>" }`; member must exist.

    An origin key (`https://host[:port]` or bare `host[:port]`) binds literal bases by
    host; a key with `://` must be exactly an origin, and two keys naming the same
    origin must agree.
    """
    if bindings is None:
        return
    if not isinstance(bindings, dict):
        raise WorkspaceError(f"{MANIFEST_NAME}: field 'bindings' must be an object")
    origins: dict[tuple[str, int | None], str] = {}
    for key, value in bindings.items():
        if not key:
            raise WorkspaceError(f"{MANIFEST_NAME}: field 'bindings' has an empty variable name")
        field = f"bindings.{key}"
        origin = binding_origin(key)
        if "://" in key and origin is None:
            raise WorkspaceError(
                f"{MANIFEST_NAME}: {field} URL key must be an origin like \"https://host[:port]\" "
                "(no path, query or credentials)")
        if origin is not None and isinstance(value, str):
            other = origins.setdefault(origin, key)
            if other != key and bindings[other] != value:
                raise WorkspaceError(
                    f"{MANIFEST_NAME}: {field} and bindings.{other} name the same origin with different targets")
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


def read_manifest(root: Path) -> Any:
    """Parsed (not yet validated) manifest at `root`, or WorkspaceError."""
    path = root / MANIFEST_NAME
    if not path.is_file():
        raise WorkspaceError(f"{MANIFEST_NAME} not found at {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise WorkspaceError(f"{MANIFEST_NAME} at {path} is not valid JSON: {e}") from e


def load_manifest(root: Path) -> tuple[str, list[dict[str, Any]]]:
    return validate_manifest(root, read_manifest(root))


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


# ── Final validation ────────────────────────────────────────────────────────

MAX_REPORTED_ISSUES = 20


def validate_workspace_graph(graph: dict[str, Any]) -> list[str]:
    """Structural rules of the plugin's inline validator (SKILL.md, Phase 6).

    No duplicate or missing node ids, no dangling edges, every layer / tour
    reference resolves, every node of a `LAYERED_TYPES` type sits in exactly one
    layer, layer ids are unique. Returns the issues (empty ⇒ valid).
    """
    issues: list[str] = []
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    layers = graph.get("layers")
    tour = graph.get("tour")
    if not isinstance(nodes, list):
        return ["graph.nodes is missing or not an array"]
    if not isinstance(edges, list):
        issues.append("graph.edges is missing or not an array")
        edges = []
    if not isinstance(layers, list):
        issues.append("graph.layers is missing or not an array")
        layers = []
    if not isinstance(tour, list):
        issues.append("graph.tour is missing or not an array")
        tour = []

    ids: set[Any] = set()
    for i, n in enumerate(nodes):
        nid = n.get("id") if isinstance(n, dict) else None
        if not isinstance(nid, str) or not nid:
            issues.append(f"node[{i}] has no id")
            continue
        if nid in ids:
            issues.append(f"duplicate node id '{nid}'")
        ids.add(nid)

    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            issues.append(f"edge[{i}] is not an object")
            continue
        for end in ("source", "target"):
            if e.get(end) not in ids:
                issues.append(f"edge[{i}] {e.get('source')} -> {e.get('target')} ({e.get('type', '?')}): "
                              f"{end} '{e.get(end)}' not found")

    assigned: dict[str, str] = {}
    layer_ids: set[Any] = set()
    for i, layer in enumerate(layers):
        if not isinstance(layer, dict) or not isinstance(layer.get("id"), str) or not layer["id"]:
            issues.append(f"layer[{i}] has no id")
            continue
        lid = layer["id"]
        if lid in layer_ids:
            issues.append(f"duplicate layer id '{lid}'")
        layer_ids.add(lid)
        node_ids = layer.get("nodeIds")
        if not isinstance(node_ids, list):
            issues.append(f"layer '{lid}' has no nodeIds array")
            continue
        for nid in node_ids:
            if nid not in ids:
                issues.append(f"layer '{lid}' refs missing node '{nid}'")
            elif nid in assigned:
                issues.append(f"node '{nid}' appears in layers '{assigned[nid]}' and '{lid}'")
            else:
                assigned[nid] = lid

    for n in nodes:
        if isinstance(n, dict) and n.get("type") in LAYERED_TYPES and isinstance(n.get("id"), str) \
                and n["id"] not in assigned:
            issues.append(f"{n['type']} node '{n['id']}' is not in any layer")

    for i, step in enumerate(tour):
        if not isinstance(step, dict):
            issues.append(f"tour step[{i}] is not an object")
            continue
        for nid in step.get("nodeIds") or []:
            if nid not in ids:
                issues.append(f"tour step[{i}] ('{step.get('title', '')}') refs missing node '{nid}'")
    return issues


def assert_valid_workspace_graph(graph: dict[str, Any]) -> None:
    """Raise WorkspaceError listing the violations of `validate_workspace_graph`."""
    issues = validate_workspace_graph(graph)
    if not issues:
        return
    shown = issues[:MAX_REPORTED_ISSUES]
    more = len(issues) - len(shown)
    raise WorkspaceError(
        f"workspace graph fails validation ({len(issues)} issue{'s' if len(issues) != 1 else ''}); "
        "nothing written:\n  - " + "\n  - ".join(shown) + (f"\n  ... and {more} more" if more else ""))


# ── Workspace tour (system-level narrative) ─────────────────────────────────

WORKSPACE_TOUR_NAME = "workspace-tour.json"
WORKSPACE_TOUR_INPUT_NAME = "workspace-tour-input.json"
TOUR_INPUT_TOP_LAYERS = 5
TOUR_INPUT_TOP_CONTRACTS = 10


def _member_of_id(nid: Any, members: set[str]) -> str | None:
    """Member owning a namespaced id (`file:M/a`, `M/x`); None if the segment is not a member."""
    if not isinstance(nid, str):
        return None
    rest = nid.partition(":")[2] if ":" in nid else nid
    head, sep, _tail = rest.partition("/")
    return head if sep and head in members else None


def _is_shared_contract_node(node: dict[str, Any]) -> bool:
    """Linker-created channels / shared tables belong to no member (core `isSharedContractNode`)."""
    tags = node.get("tags")
    return node.get("type") in {"concept", "table"} and isinstance(tags, list) and "contract" in tags


def build_service_links(graph: dict[str, Any], members: list[str]) -> list[dict[str, Any]]:
    """Member → member links aggregated by kind (port of core `buildServiceGraph` links).

    `calls`: cross-member `calls` edges; `messages`: channels the source publishes
    and the target subscribes to; `tables`: shared tables (writer → reader when
    only one side writes, else manifest order).
    """
    member_set = set(members)
    nodes_by_id = {n.get("id"): n for n in graph.get("nodes", []) if isinstance(n, dict)}

    def member_of(nid: Any) -> str | None:
        node = nodes_by_id.get(nid)
        if node is not None and _is_shared_contract_node(node):
            return None
        return _member_of_id(nid, member_set)

    links: dict[tuple[str, str], dict[str, Any]] = {}

    def link(source: str, target: str) -> dict[str, Any]:
        return links.setdefault((source, target),
                                {"source": source, "target": target, "calls": 0, "messages": 0, "tables": 0})

    hubs: dict[str, dict[str, set[str]]] = {k: {} for k in ("publishes", "subscribes", "writes_to", "reads_from")}
    for e in graph.get("edges", []):
        if not isinstance(e, dict):
            continue
        sm = member_of(e.get("source"))
        if not sm:
            continue
        etype = e.get("type")
        if etype == "calls":
            tm = member_of(e.get("target"))
            if tm and tm != sm:
                link(sm, tm)["calls"] += 1
        elif etype in hubs and isinstance(e.get("target"), str):
            hubs[etype].setdefault(e["target"], set()).add(sm)

    for channel, pubs in hubs["publishes"].items():
        for p in pubs:
            for s in hubs["subscribes"].get(channel, set()):
                if p != s:
                    link(p, s)["messages"] += 1

    order = {m: i for i, m in enumerate(members)}
    writers, readers = hubs["writes_to"], hubs["reads_from"]
    for table in sorted(set(writers) | set(readers)):
        w, r = writers.get(table, set()), readers.get(table, set())
        touching = sorted(w | r, key=lambda m: order[m])
        for i in range(len(touching)):
            for j in range(i + 1, len(touching)):
                a, b = touching[i], touching[j]
                if a not in w and b in w:
                    a, b = b, a
                link(a, b)["tables"] += 1

    return sorted(links.values(), key=lambda l: (order[l["source"]], order[l["target"]]))


def _first_tour_step(tour: Any) -> dict[str, Any] | None:
    steps = [s for s in tour if isinstance(s, dict)] if isinstance(tour, list) else []
    if not steps:
        return None
    return min(enumerate(steps), key=lambda ix: (
        ix[1]["order"] if isinstance(ix[1].get("order"), (int, float)) and not isinstance(ix[1].get("order"), bool)
        else float("inf"), ix[0]))[1]


def build_workspace_tour_input(
    merged: dict[str, Any],
    loaded: list[tuple[dict[str, Any], dict[str, Any]]],
    output_language: str | None = None,
) -> dict[str, Any]:
    """Deterministic input for the workspace tour (tour-builder, system tour).

    members (description, languages, file count, top layers, first tour step's
    nodeIds), the member → member service links, the top cross-service contracts
    (endpoints by consumers, channels, shared tables) and a `nodes` index with
    every node id the input mentions — the only ids the tour may use.
    """
    names = [m["name"] for m, _g in loaded]
    member_set = set(names)
    nodes_by_id = {n.get("id"): n for n in merged["nodes"] if isinstance(n, dict)}
    mentioned: set[str] = set()

    def mention(nid: Any) -> bool:
        if isinstance(nid, str) and nid in nodes_by_id:
            mentioned.add(nid)
            return True
        return False

    members_out: list[dict[str, Any]] = []
    for member, graph in loaded:
        mname = member["name"]
        project = graph.get("project") if isinstance(graph.get("project"), dict) else {}
        description = project.get("description")
        layers = [l for l in graph.get("layers", []) or [] if isinstance(l, dict)]
        ranked = sorted(enumerate(layers), key=lambda il: (
            -len(il[1].get("nodeIds") or []) if isinstance(il[1].get("nodeIds"), list) else 0, il[0]))
        top_layers = [{"id": namespace_id(mname, l.get("id")), "name": l.get("name", ""),
                       "nodes": len(l["nodeIds"]) if isinstance(l.get("nodeIds"), list) else 0}
                      for _i, l in ranked[:TOUR_INPUT_TOP_LAYERS]]
        first = _first_tour_step(graph.get("tour"))
        start = [nid for nid in _namespace_ids(mname, (first or {}).get("nodeIds") or []) if mention(nid)]
        members_out.append({
            "name": mname,
            "description": description if isinstance(description, str) else "",
            "languages": sorted(_str_list(project.get("languages"))),
            "frameworks": sorted(_str_list(project.get("frameworks"))),
            "files": sum(1 for n in graph.get("nodes", []) if isinstance(n, dict)
                         and n.get("type") in FILE_LEVEL_TYPES),
            "topLayers": top_layers,
            "tourStart": start,
        })

    def owner(nid: Any) -> str | None:
        node = nodes_by_id.get(nid)
        if node is not None and _is_shared_contract_node(node):
            return None
        return _member_of_id(nid, member_set)

    order = {m: i for i, m in enumerate(names)}

    def side(entries: set[tuple[str, str]]) -> list[dict[str, str]]:
        return [{"member": m, "nodeId": nid}
                for m, nid in sorted(entries, key=lambda mn: (order.get(mn[0], len(order)), mn[1]))]

    endpoints: dict[str, dict[str, set[tuple[str, str]]]] = {}
    channels: dict[str, dict[str, set[tuple[str, str]]]] = {}
    tables: dict[str, dict[str, set[tuple[str, str]]]] = {}
    routes_into: dict[str, set[tuple[str, str]]] = {}
    for e in merged["edges"]:
        if not isinstance(e, dict):
            continue
        src, tgt, etype = e.get("source"), e.get("target"), e.get("type")
        sm = owner(src)
        if not sm or not isinstance(tgt, str):
            continue
        if etype == "calls":
            tm = owner(tgt)
            if tm and tm != sm and (nodes_by_id.get(tgt) or {}).get("type") == "endpoint":
                endpoints.setdefault(tgt, {"consumers": set()})["consumers"].add((sm, src))
        elif etype == "routes":
            routes_into.setdefault(tgt, set()).add((sm, src))
        elif etype in ("publishes", "subscribes") and _is_shared_contract_node(nodes_by_id.get(tgt) or {}):
            key = "publishers" if etype == "publishes" else "subscribers"
            channels.setdefault(tgt, {"publishers": set(), "subscribers": set()})[key].add((sm, src))
        elif etype in ("writes_to", "reads_from") and _is_shared_contract_node(nodes_by_id.get(tgt) or {}):
            key = "writers" if etype == "writes_to" else "readers"
            tables.setdefault(tgt, {"writers": set(), "readers": set()})[key].add((sm, src))

    def node_name(nid: str) -> str:
        name = (nodes_by_id.get(nid) or {}).get("name")
        return name if isinstance(name, str) else nid

    endpoint_rows = []
    for nid, data in endpoints.items():
        consumers = data["consumers"]
        endpoint_rows.append({
            "id": nid, "name": node_name(nid), "member": owner(nid),
            "providers": side(routes_into.get(nid, set())),
            "consumers": side(consumers),
            "consumerMembers": len({m for m, _ in consumers}),
        })
    endpoint_rows.sort(key=lambda r: (-r["consumerMembers"], -len(r["consumers"]), r["id"]))

    channel_rows = [{"id": nid, "name": node_name(nid),
                     "publishers": side(d["publishers"]), "subscribers": side(d["subscribers"])}
                    for nid, d in channels.items()]
    channel_rows.sort(key=lambda r: (-len({x["member"] for x in r["publishers"] + r["subscribers"]}),
                                     -(len(r["publishers"]) + len(r["subscribers"])), r["id"]))

    table_rows = [{"id": nid, "name": node_name(nid), "writers": side(d["writers"]), "readers": side(d["readers"])}
                  for nid, d in tables.items()]
    table_rows.sort(key=lambda r: (-len({x["member"] for x in r["writers"] + r["readers"]}),
                                   -(len(r["writers"]) + len(r["readers"])), r["id"]))

    contracts = {"endpoints": endpoint_rows[:TOUR_INPUT_TOP_CONTRACTS],
                 "channels": channel_rows[:TOUR_INPUT_TOP_CONTRACTS],
                 "tables": table_rows[:TOUR_INPUT_TOP_CONTRACTS]}
    for group, rows in contracts.items():
        for row in rows:
            mention(row["id"])
            for k in ("providers", "consumers", "publishers", "subscribers", "writers", "readers"):
                for entry in row.get(k, []):
                    mention(entry["nodeId"])

    links = build_service_links(merged, names)
    nodes_index = {}
    for nid in sorted(mentioned):
        n = nodes_by_id[nid]
        nodes_index[nid] = {"type": n.get("type"), "name": n.get("name"), "member": owner(nid),
                            "summary": n.get("summary", "") if isinstance(n.get("summary"), str) else ""}
    out: dict[str, Any] = {
        "version": 1,
        "workspace": merged["project"]["workspace"]["name"],
        "crossServiceLinks": sum(l["calls"] + l["messages"] + l["tables"] for l in links),
        "members": members_out,
        "services": {"links": links},
        "contracts": contracts,
        "nodes": nodes_index,
    }
    if output_language:
        out["outputLanguage"] = output_language
    return out


def load_workspace_tour(ua_dir: Path) -> tuple[list[dict[str, Any]] | None, list[str]]:
    """Read `<ua>/workspace-tour.json` → (steps | None when absent/unusable, warnings).

    Accepts a plain array (the contract) or a `{ "steps": [...] }` envelope.
    Steps need a string `title`; `nodeIds` entries must be strings.
    """
    path = ua_dir / WORKSPACE_TOUR_NAME
    if not path.is_file():
        return None, []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return None, [f"{path} is not valid JSON ({e}); workspace tour ignored"]
    if isinstance(data, dict) and isinstance(data.get("steps"), list):
        data = data["steps"]
    if not isinstance(data, list):
        return None, [f"{path} must be an array of steps; workspace tour ignored"]
    ranked: list[tuple[float, int, dict[str, Any]]] = []
    warnings: list[str] = []
    for i, raw in enumerate(data):
        if not isinstance(raw, dict) or not isinstance(raw.get("title"), str) or not raw["title"].strip():
            warnings.append(f"workspace tour step[{i}] has no title; skipped")
            continue
        step: dict[str, Any] = {
            "title": raw["title"],
            "description": raw.get("description") if isinstance(raw.get("description"), str) else "",
            "nodeIds": [n for n in raw.get("nodeIds") or [] if isinstance(n, str)]
            if isinstance(raw.get("nodeIds"), list) else [],
        }
        if isinstance(raw.get("languageLesson"), str) and raw["languageLesson"]:
            step["languageLesson"] = raw["languageLesson"]
        o = raw.get("order")
        ranked.append((o if isinstance(o, (int, float)) and not isinstance(o, bool) else float("inf"), i, step))
    ranked.sort(key=lambda t: (t[0], t[1]))
    return [s for _o, _i, s in ranked], warnings


def apply_workspace_tour(graph: dict[str, Any], steps: list[dict[str, Any]]) -> list[str]:
    """Put `steps` before the member tours, drop unknown nodeIds, renumber `order` 1..N.

    Returns one warning per dropped node id.
    """
    ids = {n.get("id") for n in graph["nodes"] if isinstance(n, dict)}
    warnings: list[str] = []
    placed: list[dict[str, Any]] = []
    for step in steps:
        kept = []
        for nid in step["nodeIds"]:
            if nid in ids:
                if nid not in kept:
                    kept.append(nid)
            else:
                warnings.append(f"workspace tour step '{step['title']}': dropped unknown node '{nid}'")
        placed.append({**step, "nodeIds": kept})
    member_tour = graph["tour"] if isinstance(graph.get("tour"), list) else []
    graph["tour"] = placed + member_tour
    for i, step in enumerate(graph["tour"], start=1):
        if isinstance(step, dict):
            step["order"] = i
    return warnings


# ── Output ──────────────────────────────────────────────────────────────────

def workspace_output_language(ua_dir: Path, config_to_write: dict[str, Any] | None) -> str | None:
    """The `outputLanguage` the workspace config holds after this merge."""
    if config_to_write is not None:
        return config_to_write.get("outputLanguage")
    try:
        lang = json.loads((ua_dir / "config.json").read_text(encoding="utf-8")).get("outputLanguage")
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    return lang if isinstance(lang, str) and lang else None


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


def load_contract_linker() -> Any:
    """Load link-contracts.py (same directory), sharing this module with it."""
    import importlib.util

    # link-contracts.py imports this script under that name; registering it
    # first keeps a single WorkspaceError class across both modules.
    sys.modules.setdefault("_ua_merge_workspace_graphs", sys.modules[__name__])
    path = Path(__file__).resolve().with_name("link-contracts.py")
    spec = importlib.util.spec_from_file_location("_ua_link_contracts", path)
    if spec is None or spec.loader is None:
        raise WorkspaceError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    args = sys.argv[1:]
    validate_only = "--validate-only" in args
    no_contracts = "--no-contracts" in args
    positional = [a for a in args if a not in FLAGS]
    if len(positional) != 1 or positional[0].startswith("-"):
        print(USAGE, file=sys.stderr)
        sys.exit(1)

    root = Path(positional[0]).resolve()
    linker = None
    contracts_report = None
    link_warnings: list[str] = []
    tour_warnings: list[str] = []
    ws_tour = None
    try:
        if not root.is_dir():
            raise WorkspaceError(f"workspace root {root} is not a directory")
        manifest = read_manifest(root)
        ws_name, members = validate_manifest(root, manifest)
        if validate_only:
            print(json.dumps({
                "name": ws_name,
                "members": [{"name": m["name"], "path": m["path"], "dir": str(m["dir"])}
                            for m in members],
            }, indent=2))
            return
        loaded = [(m, load_member_graph(m)) for m in members]
        merged, report, _dropped = merge_workspace(ws_name, loaded)
        merge_totals = (len(merged["nodes"]), len(merged["edges"]), len(merged["layers"]), len(merged["tour"]))
        if not no_contracts:
            linker = load_contract_linker()
            contracts_report, link_warnings = linker.link_workspace(merged, members, manifest)
        ua_dir = resolve_ua_dir(root)
        ws_tour, tour_warnings = load_workspace_tour(ua_dir)
        if ws_tour is not None:
            tour_warnings += apply_workspace_tour(merged, ws_tour)
        assert_valid_workspace_graph(merged)
    except WorkspaceError as e:
        for w in link_warnings + tour_warnings:
            print(f"Warning: {w}", file=sys.stderr)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    for line in report:
        print(line, file=sys.stderr)
    for w in link_warnings + tour_warnings:
        print(f"Warning: {w}", file=sys.stderr)

    ua_dir.mkdir(parents=True, exist_ok=True)
    project = merged["project"]
    meta = {
        "lastAnalyzedAt": project["analyzedAt"],
        "gitCommitHash": project["gitCommitHash"],
        "version": merged["version"],
        "analyzedFiles": sum(1 for n in merged["nodes"] if n.get("type") in FILE_LEVEL_TYPES),
        "workspace": True,
    }
    member_language = load_member_output_language(members[0])
    config = build_config(ua_dir, member_language)
    tour_input = build_workspace_tour_input(
        merged, loaded, workspace_output_language(ua_dir, config) or member_language)

    _atomic_write_json(ua_dir / "knowledge-graph.json", merged)
    _atomic_write_json(ua_dir / "meta.json", meta)
    if config is not None:
        _atomic_write_json(ua_dir / "config.json", config)
    report_path = ua_dir / CONTRACTS_REPORT_NAME
    if contracts_report is not None:
        _atomic_write_json(report_path, contracts_report)
    elif report_path.exists():
        # --no-contracts: a report from an earlier linked merge no longer describes this graph.
        report_path.unlink()
    (ua_dir / "intermediate").mkdir(exist_ok=True)
    _atomic_write_json(ua_dir / "intermediate" / WORKSPACE_TOUR_INPUT_NAME, tour_input)

    for m in project["workspace"]["members"]:
        commit = str(m["gitCommitHash"])[:7] or "?"
        print(f"  {m['name']}: {m['nodes']} nodes, {m['edges']} edges @ {commit}")
    nodes, edges, layers, tour = merge_totals
    print(f"Workspace '{ws_name}' total: {nodes} nodes, {edges} edges, "
          f"{layers} layers, {tour} tour steps "
          f"({len(report)} dropped edges) -> {ua_dir / 'knowledge-graph.json'}")
    if linker is not None and contracts_report is not None:
        print(linker.summary_line(contracts_report, report_path))
    tour_input_path = ua_dir / "intermediate" / WORKSPACE_TOUR_INPUT_NAME
    if ws_tour is not None:
        print(f"Workspace tour: {len(ws_tour)} steps from {ua_dir / WORKSPACE_TOUR_NAME} placed first "
              f"({len(tour_warnings)} warnings); tour input -> {tour_input_path}")
    else:
        print(f"Workspace tour input: {tour_input['crossServiceLinks']} cross-service links -> {tour_input_path}")


if __name__ == "__main__":
    main()

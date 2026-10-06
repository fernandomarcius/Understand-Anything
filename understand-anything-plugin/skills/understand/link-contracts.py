#!/usr/bin/env python3
"""
link-contracts.py — Deterministic cross-service contract linker for a
multi-repo workspace (docs/multi-repo-workspace.md, "Cross-service contracts").

Reads each member's `.ua/contracts.json` (written by extract-contracts.mjs),
resolves where every outbound HTTP call points (manifest `bindings` → env
values → members' `services` → unresolved), matches it against the target
member's routes and emits the links into the already-merged workspace graph:

    endpoint nodes + `routes` edges   provider file → endpoint (matched routes only)
    `calls` edges                     consumer file → endpoint (crossService, confidence, evidence)
    `publishes` / `subscribes`        file → shared `concept:<system>/<channel>` node
    `writes_to` / `reads_from`        file → shared `table:workspace/<schema.table>` node
                                      (only for tables touched by >= 2 members)

Everything it adds carries `"generatedBy": "link-contracts"` and every node it
creates sits in the layer `layer:workspace/contratos` (absent when it creates
none); a re-run first removes those items, so the output is byte-identical for
the same inputs. The workspace node-count invariant becomes
`len(nodes) == sum(members[].nodes) + project.workspace.contracts.nodes`, and
the result must pass merge-workspace-graphs.py's `validate_workspace_graph`
before anything is written.

Usage:
    python link-contracts.py <workspace-root>

Output:
    <ua-dir>/knowledge-graph.json     updated in place
    <ua-dir>/contracts-report.json    pairs matrix, unresolved / unmatched
                                      consumers with reasons, providers without
                                      consumers, messages, tables, coverage
    <ua-dir>/meta.json                `analyzedFiles` refreshed if needed

Stdlib only; no LLM involved. Usually run in memory by merge-workspace-graphs.py
(`link_workspace`); this CLI re-links an already merged graph.
"""

from __future__ import annotations

import fnmatch
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

GENERATED = "link-contracts"
REPORT_NAME = "contracts-report.json"
CONTRACTS_LAYER = {
    "id": "layer:workspace/contratos",
    "name": "Contratos entre serviços",
    "description": "Pontos de contato entre os membros do workspace criados pelo link-contracts: "
                   "endpoints HTTP chamados por outro serviço, canais de mensagem compartilhados e "
                   "tabelas tocadas por dois ou mais membros.",
}
CONTRACTS_NAME = "contracts.json"
SUPPORTED_VERSION = 1

# Confidence multipliers: how the route matched and how the target was resolved.
MATCH_FACTOR = {0: 1.0, 1: 0.9, 2: 0.5}  # literal, templated, catch-all
RESOLUTION_FACTOR = {"binding": 1.0, "manifest-env": 1.0, "env": 0.9, "literal": 0.9}
ANY_METHODS = {"", "ANY", "*"}


def _load_merge_module() -> Any:
    # merge-workspace-graphs.py registers itself under this name before loading
    # this module, so both share one WorkspaceError class.
    cached = sys.modules.get("_ua_merge_workspace_graphs")
    if cached is not None:
        return cached
    path = Path(__file__).resolve().with_name("merge-workspace-graphs.py")
    spec = importlib.util.spec_from_file_location("_ua_merge_workspace_graphs", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_ua_merge_workspace_graphs"] = module
    spec.loader.exec_module(module)
    return module


_mwg = _load_merge_module()
WorkspaceError = _mwg.WorkspaceError
FILE_LEVEL_TYPES = _mwg.FILE_LEVEL_TYPES
parse_binding = _mwg.parse_binding


# ── Route normalization (docs: "Route normalization") ───────────────────────

_SCHEME_HOST_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*")
_COLON_PARAM_RE = re.compile(r"(^|/):[A-Za-z_][A-Za-z0-9_]*")
_ANGLE_PARAM_RE = re.compile(r"<[^<>/]*>")


def _matching_brace(s: str, start: int) -> int:
    """Index of the `}` closing the `{` at `start` (nested braces counted), or -1."""
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _replace_braces(s: str) -> str:
    """`${expr}` (nested ok), `{id}`, `{id:int}`, `{**x}`, `{0}` → `{}`."""
    out: list[str] = []
    i = 0
    while i < len(s):
        start = i + 1 if s.startswith("${", i) else i if s[i] == "{" else -1
        if start >= 0:
            end = _matching_brace(s, start)
            if end > 0:
                out.append("{}")
                i = end + 1
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def normalize_route(raw: Any) -> str:
    """Normalize a provider route or consumer path; keeps the original case."""
    if not isinstance(raw, str):
        return "/"
    s = _SCHEME_HOST_RE.sub("", raw.strip())
    s = _replace_braces(s)
    s = _ANGLE_PARAM_RE.sub("{}", s)
    s = re.split(r"[?#]", s, maxsplit=1)[0]
    s = _COLON_PARAM_RE.sub(lambda m: m.group(1) + "{}", s)
    s = re.sub(r"/+", "/", "/" + s)
    if len(s) > 1:
        s = s.rstrip("/") or "/"
    return s


def has_catch_all(raw: Any) -> bool:
    return isinstance(raw, str) and re.search(r"\{\*", raw) is not None


def join_paths(*parts: Any) -> str:
    segs = [p.strip("/") for p in parts if isinstance(p, str) and p.strip("/")]
    return normalize_route("/" + "/".join(segs))


# ── URL / service resolution ────────────────────────────────────────────────

_URL_RE = re.compile(
    r"^(?:(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*)://)?(?P<host>[A-Za-z0-9._-]+)(?::(?P<port>\d+))?(?P<path>/[^?#]*)?(?:[?#].*)?$")


def parse_url(value: Any) -> tuple[str, int | None, str] | None:
    """URL or bare host:port → (host lowercased, port|None, normalized path); None if not URL-like."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or re.search(r"\s", v):
        return None
    m = _URL_RE.match(v)
    if not m:
        return None
    host, port = m.group("host"), m.group("port")
    if not m.group("scheme") and not port and "." not in host:
        return None
    return host.lower(), int(port) if port else None, normalize_route(m.group("path") or "/")


def published_port(spec: Any) -> int | None:
    """Compose port spec → published (host-side) port: `8082:8080`, `ip:8082:8080`, `8089`, `8095/tcp`."""
    if isinstance(spec, int):
        return spec
    if not isinstance(spec, str):
        return None
    parts = spec.split("/", 1)[0].split(":")
    candidate = parts[0] if len(parts) <= 2 else parts[1]
    return int(candidate) if candidate.isdigit() else None


class _ServiceIndex:
    def __init__(self, contracts_by_member: dict[str, dict[str, Any]]):
        self.by_host: dict[str, set[str]] = {}
        self.by_port: dict[int, set[str]] = {}
        for member, contracts in contracts_by_member.items():
            for svc in _list(contracts.get("services")):
                if not isinstance(svc, dict):
                    continue
                names = [svc.get("name")] + _list(svc.get("hostnames"))
                for h in names:
                    if isinstance(h, str) and h:
                        self.by_host.setdefault(h.lower(), set()).add(member)
                for p in _list(svc.get("ports")):
                    port = published_port(p)
                    if port is not None:
                        self.by_port.setdefault(port, set()).add(member)

    def lookup(self, host: str, port: int | None) -> tuple[str | None, str]:
        """Return (member, detail). member None ⇒ detail explains why."""
        hits = self.by_host.get(host)
        if not hits and port is not None:
            hits = self.by_port.get(port)
        where = f"{host}:{port}" if port is not None else host
        if not hits:
            return None, f"no member serves {where}"
        if len(hits) > 1:
            return None, f"ambiguous {where}: {', '.join(sorted(hits))}"
        return next(iter(hits)), ""


def resolve_target(consumer: dict[str, Any], member: str, ctx: dict[str, Any]) -> dict[str, Any]:
    """Resolve a consumer's target member: binding → manifest env → member env → base literal."""
    base = consumer.get("base") if isinstance(consumer.get("base"), dict) else {}
    name = base.get("name") if isinstance(base.get("name"), str) else None
    if name and name in ctx["bindings"]:
        kind, target, prefix = parse_binding(ctx["bindings"][name])
        if kind == "external":
            return {"status": "external", "target": f"external:{target}", "resolution": "binding"}
        return {"status": "member", "member": target, "basePath": prefix or "/", "resolution": "binding"}

    candidates: list[tuple[str, str]] = []
    if name and name in ctx["env"]:
        candidates.append((ctx["env"][name], "manifest-env"))
    if name:
        for entry in _list(ctx["contracts"].get(member, {}).get("env")):
            if isinstance(entry, dict) and entry.get("name") == name and isinstance(entry.get("value"), str):
                candidates.append((entry["value"], "env"))
    if isinstance(base.get("value"), str):
        candidates.append((base["value"], "literal"))

    details: list[str] = []
    seen: set[str] = set()
    for value, resolution in candidates:
        if value in seen:
            continue
        seen.add(value)
        url = parse_url(value)
        if url is None:
            details.append(f"value {value!r} is not a URL")
            continue
        target, detail = ctx["services"].lookup(url[0], url[1])
        if target:
            return {"status": "member", "member": target, "basePath": url[2], "resolution": resolution}
        details.append(detail)
    if not candidates:
        details.append(f"no value for {name}" if name else "base has no name and no value")
    return {"status": "unresolved", "detail": "; ".join(details)}


# ── Route matching ──────────────────────────────────────────────────────────

def _segments(path: str) -> list[str]:
    return [s for s in path.lower().split("/") if s]


def _seg_match(provider_seg: str, consumer_seg: str) -> bool:
    if provider_seg == "{}":
        return True
    if consumer_seg == "{}":
        return False
    return provider_seg == consumer_seg


def _route_shape(provider: dict[str, Any]) -> tuple[list[str], bool, int]:
    """(segments, is_catch_all, class) with class 0 literal / 1 templated / 2 catch-all."""
    raw = provider.get("route")
    segs = _segments(normalize_route(raw))
    catch = bool(provider.get("catchAll")) or has_catch_all(raw)
    if catch and segs and segs[-1] == "{}":
        return segs[:-1], True, 2
    return segs, False, 1 if "{}" in segs else 0


def _method_ok(consumer_method: Any, provider_method: Any) -> bool:
    c = consumer_method.upper() if isinstance(consumer_method, str) else ""
    p = provider_method.upper() if isinstance(provider_method, str) else ""
    return not c or p in ANY_METHODS or c == p


def _order(provider: dict[str, Any]) -> int:
    o = provider.get("order")
    return o if isinstance(o, int) and not isinstance(o, bool) else 0


def match_provider(method: Any, path: Any, providers: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    """Best provider for (method, full path): ('linked' | 'no-route' | 'method-mismatch').

    Literal beats templated beats catch-all; then lower `order`; ties keep the
    first by file order (file, line).
    """
    if not isinstance(path, str):
        return None, "no-route"
    want = _segments(normalize_route(path))
    ranked: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    for idx, prov in enumerate(providers):
        if not isinstance(prov, dict):
            continue
        segs, catch, cls = _route_shape(prov)
        if catch:
            ok = len(want) >= len(segs) and all(_seg_match(p, c) for p, c in zip(segs, want))
        else:
            ok = len(want) == len(segs) and all(_seg_match(p, c) for p, c in zip(segs, want))
        if ok:
            key = (cls, _order(prov), str(prov.get("file", "")), _int(prov.get("line")), idx)
            ranked.append((key, prov))
    if not ranked:
        return None, "no-route"
    ranked.sort(key=lambda kv: kv[0])
    for _key, prov in ranked:
        if _method_ok(method, prov.get("method")):
            return prov, "linked"
    return None, "method-mismatch"


def match_class(provider: dict[str, Any]) -> int:
    return _route_shape(provider)[2]


# ── Messages / tables helpers ───────────────────────────────────────────────

def channel_matches(pattern: str, channel: str) -> bool:
    return fnmatch.fnmatchcase(channel, pattern)


def _is_glob(channel: str) -> bool:
    return any(ch in channel for ch in "*?[")


def clean_table(name: str) -> str:
    return re.sub(r"[\[\]\"`]", "", name.strip())


def table_key(name: str) -> str:
    return clean_table(name).lower()


# ── Small utils ─────────────────────────────────────────────────────────────

def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _method_label(method: Any) -> str:
    return method.upper() if isinstance(method, str) and method.strip() else "ANY"


def _loc(member: str, file: Any, line: Any) -> str:
    return f"{member}/{file}:{_int(line)}"


# ── Linker ──────────────────────────────────────────────────────────────────

class _Emitter:
    """Collects contract nodes/edges on top of a graph stripped of previous links."""

    def __init__(self, graph: dict[str, Any], warnings: list[str]):
        self.warnings = warnings
        self.base_ids = {n.get("id") for n in graph["nodes"]}
        self.base_edges = {(e.get("source"), e.get("target"), e.get("type")) for e in graph["edges"]}
        self.file_nodes: dict[str, str] = {}
        for n in sorted(graph["nodes"], key=lambda n: (not str(n.get("id", "")).startswith("file:"),
                                                       str(n.get("id", "")))):
            fp = n.get("filePath")
            if n.get("type") in FILE_LEVEL_TYPES and isinstance(fp, str) and fp:
                self.file_nodes.setdefault(fp, n["id"])
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._missing_files: set[str] = set()

    def has(self, nid: str) -> bool:
        return nid in self.base_ids or nid in self.nodes

    def file_node(self, member: str, file: Any) -> str | None:
        fp = f"{member}/{file}"
        nid = self.file_nodes.get(fp)
        if nid is None and fp not in self._missing_files:
            self._missing_files.add(fp)
            self.warnings.append(f"no file node for {fp} in the workspace graph; its contract edges are skipped")
        return nid

    def node(self, node: dict[str, Any]) -> None:
        if not self.has(node["id"]):
            self.nodes[node["id"]] = {**node, "generatedBy": GENERATED}

    def edge(self, source: str | None, target: str, etype: str, weight: float, **extra: Any) -> dict[str, Any] | None:
        if source is None or not self.has(target):
            return None
        key = (source, target, etype)
        if key in self.base_edges:
            return None
        if key in self.edges:
            return self.edges[key]
        e = {"source": source, "target": target, "type": etype, "direction": "forward",
             "weight": weight, **extra, "generatedBy": GENERATED}
        self.edges[key] = e
        return e


def _endpoint_id(member: str, prov: dict[str, Any]) -> str:
    return f"endpoint:{member}/{prov.get('file')}:{_method_label(prov.get('method'))} {prov.get('route')}"


def link(graph: dict[str, Any], members: list[str], contracts: dict[str, dict[str, Any]],
         bindings: dict[str, str], env: dict[str, str], warnings: list[str]) -> dict[str, Any]:
    """Strip previous links from `graph`, add new ones in place and return the report."""
    removed_ids = {n.get("id") for n in graph["nodes"] if n.get("generatedBy") == GENERATED}
    graph["nodes"] = [n for n in graph["nodes"] if n.get("generatedBy") != GENERATED]
    kept_ids = {n.get("id") for n in graph["nodes"]}
    graph["edges"] = [e for e in graph["edges"] if e.get("generatedBy") != GENERATED
                      and e.get("source") in kept_ids and e.get("target") in kept_ids]
    _strip_contracts_layer(graph, removed_ids)
    em = _Emitter(graph, warnings)
    ctx = {"bindings": bindings, "env": env, "contracts": contracts, "services": _ServiceIndex(contracts)}

    # ── HTTP ────────────────────────────────────────────────────────────────
    linked: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    used_providers: set[tuple[str, int]] = set()
    total = 0
    for member in members:
        c = contracts.get(member)
        if c is None:
            continue
        consumers = [x for x in _list(c.get("consumers")) if isinstance(x, dict)]
        consumers = sorted(enumerate(consumers), key=lambda ic: (str(ic[1].get("file", "")),
                                                                  _int(ic[1].get("line")), ic[0]))
        for _i, cons in consumers:
            total += 1
            base = cons.get("base") if isinstance(cons.get("base"), dict) else {}
            entry = {"member": member, "file": f"{member}/{cons.get('file')}", "line": _int(cons.get("line")),
                     "method": cons.get("method"), "base": base.get("name") or base.get("value")}
            res = resolve_target(cons, member, ctx)
            if res["status"] == "external":
                unresolved.append({**entry, "path": cons.get("path"), "reason": "external", "target": res["target"]})
                continue
            if res["status"] == "unresolved":
                unresolved.append({**entry, "path": cons.get("path"), "reason": "no-binding", "detail": res["detail"]})
                continue
            target = res["member"]
            full = join_paths(res["basePath"], base.get("suffix"), cons["path"]) \
                if isinstance(cons.get("path"), str) else None
            entry.update({"path": full, "target": target, "resolution": res["resolution"]})
            if target not in contracts:
                unmatched.append({**entry, "reason": "no-route",
                                  "detail": f"member '{target}' has no {CONTRACTS_NAME}"})
                continue
            providers = [p for p in _list(contracts[target].get("providers")) if isinstance(p, dict)]
            prov, status = match_provider(cons.get("method"), full, providers)
            if prov is None:
                detail = "consumer path unknown" if full is None else \
                    ("route exists with another method" if status == "method-mismatch" else "no matching route")
                unmatched.append({**entry, "reason": status, "detail": detail})
                continue
            used_providers.add((target, next(i for i, p in enumerate(providers) if p is prov)))
            cls = match_class(prov)
            conf = cons.get("confidence")
            conf = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) and 0 < conf <= 1 else 1.0
            confidence = round(conf * MATCH_FACTOR[cls] * RESOLUTION_FACTOR[res["resolution"]], 3)
            ep = _endpoint_id(target, prov)
            method = _method_label(prov.get("method"))
            em.node({"id": ep, "type": "endpoint", "name": f"{method} {prov.get('route')}",
                     "filePath": f"{target}/{prov.get('file')}",
                     "lineRange": [_int(prov.get("line")), _int(prov.get("line"))],
                     "summary": f"HTTP {method} {prov.get('route')} exposed by {target}"
                                + (" (catch-all)" if cls == 2 else ""),
                     "tags": sorted({"endpoint", "http", "contract"}
                                    | ({prov["framework"]} if isinstance(prov.get("framework"), str)
                                       and prov["framework"] else set())),
                     "complexity": "simple"})
            em.edge(em.file_node(target, prov.get("file")), ep, "routes", 1.0,
                    description=f"{target} routes {method} {prov.get('route')}")
            evidence = {"consumer": _loc(member, cons.get("file"), cons.get("line")),
                        "provider": _loc(target, prov.get("file"), prov.get("line")),
                        "via": cons.get("via"), "base": entry["base"], "resolution": res["resolution"],
                        "path": full, "catchAll": cls == 2}
            e = em.edge(em.file_node(member, cons.get("file")), ep, "calls", confidence,
                        description=f"{cons.get('method') or 'HTTP'} {full} → {target}",
                        crossService=True, confidence=confidence, evidence=evidence, callSites=0)
            if e is not None:
                e["callSites"] += 1
                if confidence > e["confidence"]:
                    e["confidence"] = e["weight"] = confidence
            linked.append({**entry, "endpoint": ep, "confidence": confidence, "catchAll": cls == 2,
                           "provider": {"file": f"{target}/{prov.get('file')}", "line": _int(prov.get("line")),
                                        "method": method, "route": prov.get("route")}})

    pair_counts: dict[tuple[str, str], dict[str, int]] = {}
    for kind, rows in (("linked", linked), ("unmatched", unmatched)):
        for row in rows:
            pc = pair_counts.setdefault((row["member"], row["target"]), {"linked": 0, "unmatched": 0})
            pc[kind] += 1
    pairs = [{"consumer": c, "provider": p, **counts} for (c, p), counts in sorted(pair_counts.items())]

    dead: list[dict[str, Any]] = []
    for member in members:
        providers = [p for p in _list(contracts.get(member, {}).get("providers")) if isinstance(p, dict)]
        for idx, prov in enumerate(providers):
            if (member, idx) not in used_providers:
                dead.append({"member": member, "method": _method_label(prov.get("method")),
                             "route": prov.get("route"), "file": f"{member}/{prov.get('file')}",
                             "line": _int(prov.get("line"))})

    external = sum(1 for u in unresolved if u["reason"] == "external")
    eligible = total - external
    coverage = {"linked": len(linked), "eligible": eligible,
                "ratio": round(len(linked) / eligible, 4) if eligible else None}

    messages = _link_messages(em, members, contracts, warnings)
    tables = _link_tables(em, members, contracts)

    graph["nodes"].extend(em.nodes.values())
    graph["edges"].extend(em.edges.values())
    if em.nodes:
        graph["layers"].append({**CONTRACTS_LAYER, "nodeIds": sorted(em.nodes)})
    # Tour steps (e.g. the workspace tour) may cite contract nodes: drop only the ids this run did not re-create.
    _prune_tour(graph, removed_ids - em.nodes.keys())
    return {
        "version": 1,
        "members": [_member_summary(m, contracts.get(m)) for m in members],
        "pairs": pairs,
        "consumers": {"total": total, "linked": linked, "unresolved": unresolved, "unmatched": unmatched},
        "linkedToCatchAll": sum(1 for row in linked if row["catchAll"]),
        "providersWithoutConsumers": dead,
        "messages": messages,
        "tables": tables,
        "coverage": coverage,
        "graph": {"nodesAdded": len(em.nodes), "edgesAdded": len(em.edges)},
        "warnings": warnings,
    }


def _strip_contracts_layer(graph: dict[str, Any], removed_ids: set[Any]) -> None:
    """Drop the contracts layer and layer references to previously generated nodes."""
    layers = graph.get("layers") if isinstance(graph.get("layers"), list) else []
    kept: list[Any] = []
    for layer in layers:
        if isinstance(layer, dict) and layer.get("id") == CONTRACTS_LAYER["id"]:
            continue
        if removed_ids and isinstance(layer, dict) and isinstance(layer.get("nodeIds"), list):
            layer["nodeIds"] = [i for i in layer["nodeIds"] if i not in removed_ids]
        kept.append(layer)
    graph["layers"] = kept


def _prune_tour(graph: dict[str, Any], gone: set[Any]) -> None:
    if gone and isinstance(graph.get("tour"), list):
        for step in graph["tour"]:
            if isinstance(step, dict) and isinstance(step.get("nodeIds"), list):
                step["nodeIds"] = [i for i in step["nodeIds"] if i not in gone]


def _member_summary(member: str, c: dict[str, Any] | None) -> dict[str, Any]:
    if c is None:
        return {"name": member, "contracts": False}
    msgs = c.get("messages") if isinstance(c.get("messages"), dict) else {}
    tabs = c.get("tables") if isinstance(c.get("tables"), dict) else {}
    return {"name": member, "contracts": True,
            "providers": len(_list(c.get("providers"))), "consumers": len(_list(c.get("consumers"))),
            "publish": len(_list(msgs.get("publish"))), "subscribe": len(_list(msgs.get("subscribe"))),
            "reads": len(_list(tabs.get("reads"))), "writes": len(_list(tabs.get("writes")))}


def _entries(c: dict[str, Any], group: str, kind: str) -> list[dict[str, Any]]:
    g = c.get(group) if isinstance(c.get(group), dict) else {}
    return [x for x in _list(g.get(kind)) if isinstance(x, dict)]


def _link_messages(em: _Emitter, members: list[str], contracts: dict[str, dict[str, Any]],
                   warnings: list[str]) -> dict[str, Any]:
    def system_of(x: dict[str, Any]) -> str:
        s = x.get("system")
        return s.lower() if isinstance(s, str) and s else "unknown"

    pubs: list[tuple[str, dict[str, Any]]] = []
    subs: list[tuple[str, dict[str, Any]]] = []
    for member in members:
        c = contracts.get(member)
        if c is None:
            continue
        pubs += [(member, x) for x in _entries(c, "messages", "publish") if isinstance(x.get("channel"), str)]
        subs += [(member, x) for x in _entries(c, "messages", "subscribe") if isinstance(x.get("channel"), str)]

    channels: dict[tuple[str, str], dict[str, list[str]]] = {}
    for member, x in pubs:
        channels.setdefault((system_of(x), x["channel"]), {"publishers": [], "subscribers": []})

    def compatible(a: str, b: str) -> bool:
        return a == b or "unknown" in (a, b)

    sub_targets: list[tuple[str, dict[str, Any], list[tuple[str, str]]]] = []
    unmatched_subs: list[dict[str, Any]] = []
    for member, x in subs:
        sysname, ch = system_of(x), x["channel"]
        if _is_glob(ch):
            keys = sorted(k for k in channels if compatible(k[0], sysname) and channel_matches(ch, k[1]))
            if not keys:
                unmatched_subs.append({"member": member, "channel": ch, "system": sysname,
                                       "subscriber": _loc(member, x.get("file"), x.get("line"))})
                warnings.append(f"subscription '{ch}' ({sysname}) at {_loc(member, x.get('file'), x.get('line'))} "
                                "matches no published channel")
        elif (sysname, ch) in channels:
            keys = [(sysname, ch)]
        else:
            same = sorted(k for k in channels if k[1] == ch and compatible(k[0], sysname))
            keys = same[:1] if len(same) == 1 else [(sysname, ch)]
            channels.setdefault(keys[0], {"publishers": [], "subscribers": []})
        sub_targets.append((member, x, keys))

    def cid(key: tuple[str, str]) -> str:
        return f"concept:{key[0]}/{key[1]}"

    for key in sorted(channels):
        em.node({"id": cid(key), "type": "concept", "name": key[1],
                 "summary": f"{key[0]} message channel '{key[1]}' shared across services",
                 "tags": sorted({"message-channel", "contract", key[0]}), "complexity": "simple"})
    for member, x in pubs:
        key = (system_of(x), x["channel"])
        channels[key]["publishers"].append(_loc(member, x.get("file"), x.get("line")))
        em.edge(em.file_node(member, x.get("file")), cid(key), "publishes", 0.9,
                description=f"publishes to {key[0]} channel '{key[1]}'")
    for member, x, keys in sub_targets:
        for key in keys:
            channels[key]["subscribers"].append(_loc(member, x.get("file"), x.get("line")))
            em.edge(em.file_node(member, x.get("file")), cid(key), "subscribes", 0.9,
                    description=f"subscribes to {key[0]} channel '{key[1]}'"
                                + (f" via '{x['channel']}'" if x["channel"] != key[1] else ""))
    return {
        "channels": [{"id": cid(k), "system": k[0], "channel": k[1],
                      "publishers": sorted(v["publishers"]), "subscribers": sorted(v["subscribers"])}
                     for k, v in sorted(channels.items())],
        "unmatchedSubscriptions": unmatched_subs,
    }


def _link_tables(em: _Emitter, members: list[str], contracts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    occ: list[tuple[str, str, str, dict[str, Any]]] = []  # (member, kind, clean name, entry)
    for member in members:
        c = contracts.get(member)
        if c is None:
            continue
        for kind in ("writes", "reads"):
            for x in _entries(c, "tables", kind):
                if isinstance(x.get("table"), str) and clean_table(x["table"]):
                    occ.append((member, kind, clean_table(x["table"]), x))

    # An unqualified name folds into the only schema-qualified variant of the same table, if unique.
    qualified: dict[str, set[str]] = {}
    for _m, _k, name, _x in occ:
        key = name.lower()
        if "." in key:
            qualified.setdefault(key.rsplit(".", 1)[1], set()).add(key)

    def key_of(name: str) -> str:
        key = name.lower()
        if "." not in key and len(qualified.get(key, ())) == 1:
            return next(iter(qualified[key]))
        return key

    groups: dict[str, list[tuple[str, str, str, dict[str, Any]]]] = {}
    for o in occ:
        groups.setdefault(key_of(o[2]), []).append(o)

    shared: list[dict[str, Any]] = []
    single = 0
    for key in sorted(groups):
        rows = groups[key]
        touched = sorted({r[0] for r in rows})
        if len(touched) < 2:
            single += 1
            continue
        display = sorted({r[2] for r in rows}, key=lambda n: (-n.count("."), n))[0]
        tid = f"table:workspace/{display}"
        em.node({"id": tid, "type": "table", "name": display,
                 "summary": f"Table {display} shared by {', '.join(touched)}",
                 "tags": ["table", "shared-data", "contract"], "complexity": "simple"})
        readers, writers = [], []
        for member, kind, _name, x in rows:
            loc = _loc(member, x.get("file"), x.get("line"))
            (writers if kind == "writes" else readers).append(loc)
            etype = "writes_to" if kind == "writes" else "reads_from"
            em.edge(em.file_node(member, x.get("file")), tid, etype, 0.8,
                    description=f"{'writes' if kind == 'writes' else 'reads'} {display}")
        shared.append({"id": tid, "table": display, "members": touched,
                       "readers": sorted(readers), "writers": sorted(writers)})
    return {"shared": shared, "singleMember": single}


# ── IO ──────────────────────────────────────────────────────────────────────

def load_contracts(member: dict[str, Any], warnings: list[str]) -> dict[str, Any] | None:
    path = _mwg.resolve_ua_dir(member["dir"]) / CONTRACTS_NAME
    if not path.is_file():
        warnings.append(f"member '{member['name']}': no {CONTRACTS_NAME} at {path}; it contributes no contracts")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        warnings.append(f"member '{member['name']}': cannot parse {path}: {e}; skipped")
        return None
    if not isinstance(data, dict) or data.get("version") != SUPPORTED_VERSION:
        warnings.append(f"member '{member['name']}': {path} is not a version {SUPPORTED_VERSION} "
                        "contracts object; skipped")
        return None
    return data


def link_workspace(graph: dict[str, Any], members: list[dict[str, Any]],
                   manifest: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Link contracts into a merged workspace graph in place.

    `members` are validated manifest members ({"name", "dir", ...}). Sets
    `project.workspace.contracts`, checks the node-count invariant and returns
    (report, warnings). Raises WorkspaceError.
    """
    ws = graph.get("project", {}).get("workspace") if isinstance(graph.get("project"), dict) else None
    if not isinstance(ws, dict) or not isinstance(graph.get("nodes"), list) \
            or not isinstance(graph.get("edges"), list):
        raise WorkspaceError("not a merged workspace graph")
    if not isinstance(graph.get("layers"), list):
        graph["layers"] = []

    warnings: list[str] = []
    contracts: dict[str, dict[str, Any]] = {}
    for m in members:
        c = load_contracts(m, warnings)
        if c is not None:
            contracts[m["name"]] = c
    report = link(graph, [m["name"] for m in members], contracts,
                  manifest.get("bindings") or {}, manifest.get("env") or {}, warnings)

    ws["contracts"] = {"nodes": report["graph"]["nodesAdded"], "edges": report["graph"]["edgesAdded"]}
    expected = sum(_int(m.get("nodes")) for m in _list(ws.get("members")) if isinstance(m, dict)) \
        + ws["contracts"]["nodes"]
    if len(graph["nodes"]) != expected or len({n.get("id") for n in graph["nodes"]}) != expected:
        raise WorkspaceError(f"invariant broken: workspace has {len(graph['nodes'])} nodes, "
                             f"members + contracts sum to {expected}")
    return report, warnings


def summary_line(report: dict[str, Any], report_path: Path) -> str:
    cov = report["coverage"]
    ratio = "n/a" if cov["ratio"] is None else f"{cov['ratio']:.1%}"
    return (f"Contracts: {cov['linked']}/{cov['eligible']} consumers linked ({ratio}), "
            f"{len(report['consumers']['unresolved'])} unresolved, {len(report['consumers']['unmatched'])} "
            f"unmatched, {len(report['providersWithoutConsumers'])} providers without consumers; "
            f"+{report['graph']['nodesAdded']} nodes, +{report['graph']['edgesAdded']} edges -> {report_path}")


def run(root: Path) -> int:
    """Link contracts of the workspace at `root`. Returns the process exit code."""
    root = root.resolve()
    warnings: list[str] = []
    try:
        manifest = _mwg.read_manifest(root)
        _ws_name, members = _mwg.validate_manifest(root, manifest)
        ua_dir = _mwg.resolve_ua_dir(root)
        graph_path = ua_dir / "knowledge-graph.json"
        try:
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise WorkspaceError(f"merged workspace graph not readable at {graph_path} "
                                 f"(run merge-workspace-graphs.py first): {e}") from e
        if not isinstance(graph, dict):
            raise WorkspaceError(f"{graph_path} is not a merged workspace graph")
        try:
            report, warnings = link_workspace(graph, members, manifest)
        except WorkspaceError as e:
            raise WorkspaceError(f"{graph_path}: {e}") from e
        _mwg.assert_valid_workspace_graph(graph)
    except WorkspaceError as e:
        for w in warnings:
            print(f"Warning: {w}", file=sys.stderr)
        print(f"Error: {e}", file=sys.stderr)
        return 1

    for w in warnings:
        print(f"Warning: {w}", file=sys.stderr)

    _mwg._atomic_write_json(graph_path, graph)
    _mwg._atomic_write_json(ua_dir / REPORT_NAME, report)
    meta_path = ua_dir / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        meta = None
    if isinstance(meta, dict):
        files = sum(1 for n in graph["nodes"] if n.get("type") in FILE_LEVEL_TYPES)
        if meta.get("analyzedFiles") != files:
            meta["analyzedFiles"] = files
            _mwg._atomic_write_json(meta_path, meta)

    print(summary_line(report, ua_dir / REPORT_NAME))
    return 0


def main() -> None:
    args = sys.argv[1:]
    if len(args) != 1 or args[0].startswith("-"):
        print("Usage: python link-contracts.py <workspace-root>", file=sys.stderr)
        sys.exit(1)
    sys.exit(run(Path(args[0])))


if __name__ == "__main__":
    main()

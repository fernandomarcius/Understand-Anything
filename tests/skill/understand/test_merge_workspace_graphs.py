#!/usr/bin/env python3
"""
test_merge_workspace_graphs.py — Tests for merge-workspace-graphs.py, the
deterministic merge of several member graphs into one workspace graph
(docs/multi-repo-workspace.md).

Run from the repo root:
    python -m unittest tests.skill.understand.test_merge_workspace_graphs -v
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


# ── Module loader ─────────────────────────────────────────────────────────
# `merge-workspace-graphs.py` has hyphens in its name, so we cannot `import`
# it directly. Load it via importlib so we can call its module-level helpers.

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent.parent
_MODULE_PATH = (
    _REPO_ROOT
    / "understand-anything-plugin"
    / "skills"
    / "understand"
    / "merge-workspace-graphs.py"
)


def _load_module() -> Any:
    spec = importlib.util.spec_from_file_location("merge_workspace_graphs", _MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module from {_MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["merge_workspace_graphs"] = module
    spec.loader.exec_module(module)
    return module


mwg = _load_module()


# ── Helpers ───────────────────────────────────────────────────────────────

def _node(nid: str, ntype: str, file_path: str | None = None, **extra: Any) -> dict[str, Any]:
    node: dict[str, Any] = {
        "id": nid,
        "type": ntype,
        "name": nid.split(":")[-1],
        "summary": f"summary of {nid}",
        "tags": ["t1", "t2"],
        "complexity": "moderate",
    }
    if file_path is not None:
        node["filePath"] = file_path
    node.update(extra)
    return node


def _edge(src: str, tgt: str, etype: str = "contains", weight: float = 0.8) -> dict[str, Any]:
    return {"source": src, "target": tgt, "type": etype, "direction": "forward", "weight": weight}


def _member_graph(
    *,
    commit: str,
    description: str,
    languages: list[str],
    frameworks: list[str],
    version: str = "1.0.0",
    extra_nodes: list[dict] | None = None,
    extra_edges: list[dict] | None = None,
) -> dict[str, Any]:
    """A member graph where every node ID class from the spec appears."""
    nodes = [
        _node("file:src/main.ts", "file", "src/main.ts", lineRange=[1, 40]),
        _node("function:src/main.ts:run", "function", "src/main.ts", lineRange=[3, 9]),
        _node("config:package.json", "config", "package.json"),
        _node("module:core", "module"),
        _node("concept:x", "concept"),
        _node("class:src/a.py:Type.method", "class", "src/a.py"),
        _node("document:README.md", "document", "README.md"),
        _node("service:Dockerfile", "service", "Dockerfile"),
        _node("pipeline:.github/workflows/ci.yml", "pipeline", ".github/workflows/ci.yml"),
        _node("schema:db/schema.sql", "schema", "db/schema.sql"),
        _node("resource:infra/main.tf", "resource", "infra/main.tf"),
        _node("table:db/schema.sql:users", "table", "db/schema.sql"),
        _node("endpoint:src/main.ts:GET /x", "endpoint", "src/main.ts"),
        _node("domain:billing", "domain", ""),
        _node("bareid", "concept"),
    ]
    edges = [
        _edge("file:src/main.ts", "function:src/main.ts:run", "contains", 1.0),
        _edge("file:src/main.ts", "config:package.json", "depends_on", 0.5),
        _edge("module:core", "file:src/main.ts", "contains", 0.9),
        _edge("concept:x", "class:src/a.py:Type.method", "related", 0.3),
        _edge("domain:billing", "endpoint:src/main.ts:GET /x", "related", 0.4),
        _edge("bareid", "concept:x", "related", 0.2),
        # Dangling in the member itself: must be dropped and reported.
        _edge("file:src/main.ts", "file:src/gone.ts", "imports", 0.7),
    ]
    nodes += extra_nodes or []
    edges += extra_edges or []
    return {
        "version": version,
        "kind": "codebase",
        "project": {
            "name": "member",
            "languages": languages,
            "frameworks": frameworks,
            "description": description,
            "analyzedAt": "2026-10-01T10:00:00.000Z",
            "gitCommitHash": commit,
        },
        "nodes": nodes,
        "edges": edges,
        "layers": [
            {"id": "layer:api", "name": "API", "description": "entry points",
             "nodeIds": ["file:src/main.ts", "function:src/main.ts:run"]},
            {"id": "layer:core", "name": "Core", "description": "core",
             "nodeIds": ["module:core", "concept:x"]},
        ],
        "tour": [
            {"order": 1, "title": "Start", "description": "entry",
             "nodeIds": ["file:src/main.ts"], "languageLesson": "ts lesson"},
            {"order": 2, "title": "Run", "description": "run",
             "nodeIds": ["function:src/main.ts:run", "config:package.json"]},
        ],
    }


class _WorkspaceCase(unittest.TestCase):
    """Builds a workspace dir with sibling member repos in a temp dir."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "ws"
        self.root.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _member(self, dirname: str, graph: dict[str, Any] | None, *,
                legacy: bool = False, config: dict | None = None,
                raw: str | None = None) -> Path:
        mdir = self.tmp / dirname
        data = mdir / (".understand-anything" if legacy else ".ua")
        data.mkdir(parents=True, exist_ok=True)
        if raw is not None:
            (data / "knowledge-graph.json").write_text(raw, encoding="utf-8")
        elif graph is not None:
            (data / "knowledge-graph.json").write_text(json.dumps(graph), encoding="utf-8")
        if config is not None:
            (data / "config.json").write_text(json.dumps(config), encoding="utf-8")
        return mdir

    def _manifest(self, manifest: Any) -> None:
        text = manifest if isinstance(manifest, str) else json.dumps(manifest)
        (self.root / "ua-workspace.json").write_text(text, encoding="utf-8")

    def _standard(self, *, legacy_b: bool = False, order: tuple[str, str] = ("brain", "motor")) -> None:
        self._member("brain-repo", _member_graph(
            commit="aaa111", description="Brain service", languages=["typescript", "python"],
            frameworks=["NestJS"], version="1.0.0",
        ), config={"outputLanguage": "pt-BR"})
        self._member("motor-repo", _member_graph(
            commit="bbb222", description="Motor service", languages=["go", "typescript"],
            frameworks=["Gin", "NestJS"], version="2.0.0",
        ), legacy=legacy_b, config={"outputLanguage": "en"})
        paths = {"brain": "../brain-repo", "motor": "../motor-repo"}
        self._manifest({"name": "cloudbi",
                        "members": [{"name": n, "path": paths[n]} for n in order]})

    def _run(self, *flags: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(_MODULE_PATH), str(self.root), *flags],
            capture_output=True, text=True,
        )

    def _out(self, name: str) -> dict[str, Any]:
        return json.loads((self.root / ".ua" / name).read_text(encoding="utf-8"))

    def _assert_nothing_written(self) -> None:
        self.assertFalse((self.root / ".ua" / "knowledge-graph.json").exists())
        self.assertFalse((self.root / ".ua" / "meta.json").exists())
        self.assertFalse((self.root / ".ua" / "config.json").exists())


# ── Pure helpers ──────────────────────────────────────────────────────────

class TestNamespaceId(unittest.TestCase):
    def test_every_prefix_class(self) -> None:
        cases = {
            # path-based
            "file:src/a.ts": "file:M/src/a.ts",
            "config:package.json": "config:M/package.json",
            "document:README.md": "document:M/README.md",
            "service:Dockerfile": "service:M/Dockerfile",
            "pipeline:.github/workflows/ci.yml": "pipeline:M/.github/workflows/ci.yml",
            "schema:db/schema.sql": "schema:M/db/schema.sql",
            "resource:infra/main.tf": "resource:M/infra/main.tf",
            # path + symbol
            "function:src/a.ts:run": "function:M/src/a.ts:run",
            "class:src/a.py:Type.method": "class:M/src/a.py:Type.method",
            "table:db/schema.sql:users": "table:M/db/schema.sql:users",
            "endpoint:src/a.ts:GET /x": "endpoint:M/src/a.ts:GET /x",
            # name-based
            "module:auth": "module:M/auth",
            "concept:x": "concept:M/x",
            # domain / knowledge / other
            "domain:billing": "domain:M/billing",
            "flow:checkout": "flow:M/checkout",
            "article:notes/x.md": "article:M/notes/x.md",
            # no colon
            "bareid": "M/bareid",
        }
        for src, want in cases.items():
            with self.subTest(src=src):
                self.assertEqual(mwg.namespace_id("M", src), want)

    def test_non_string_is_left_alone(self) -> None:
        self.assertIsNone(mwg.namespace_id("M", None))

    def test_commit_hash_is_order_independent(self) -> None:
        a = mwg.workspace_commit_hash([("brain", "aaa"), ("motor", "bbb")])
        b = mwg.workspace_commit_hash([("motor", "bbb"), ("brain", "aaa")])
        self.assertEqual(a, b)
        want = "ws:" + hashlib.sha1("brain@aaa\nmotor@bbb".encode("utf-8")).hexdigest()
        self.assertEqual(a, want)
        self.assertNotEqual(a, mwg.workspace_commit_hash([("brain", "aaa"), ("motor", "ccc")]))


# ── End-to-end merge ──────────────────────────────────────────────────────

class TestWorkspaceMerge(_WorkspaceCase):
    def test_merge_namespaces_everything(self) -> None:
        self._standard()
        res = self._run()
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._out("knowledge-graph.json")

        member_nodes = len(_member_graph(commit="", description="", languages=[], frameworks=[])["nodes"])
        # No collision: node count == sum of member node counts.
        self.assertEqual(len(g["nodes"]), 2 * member_nodes)
        ids = [n["id"] for n in g["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))
        for m in ("brain", "motor"):
            for nid in (f"file:{m}/src/main.ts", f"function:{m}/src/main.ts:run",
                        f"config:{m}/package.json", f"module:{m}/core", f"concept:{m}/x",
                        f"class:{m}/src/a.py:Type.method", f"domain:{m}/billing", f"{m}/bareid"):
                self.assertIn(nid, ids)

        # filePath prefixed; empty / absent stays as is.
        by_id = {n["id"]: n for n in g["nodes"]}
        self.assertEqual(by_id["file:brain/src/main.ts"]["filePath"], "brain/src/main.ts")
        self.assertEqual(by_id["class:motor/src/a.py:Type.method"]["filePath"], "motor/src/a.py")
        self.assertEqual(by_id["domain:brain/billing"]["filePath"], "")
        self.assertNotIn("filePath", by_id["module:brain/core"])
        # Nothing else is modified.
        n = by_id["function:motor/src/main.ts:run"]
        self.assertEqual(n["summary"], "summary of function:src/main.ts:run")
        self.assertEqual(n["tags"], ["t1", "t2"])
        self.assertEqual(n["complexity"], "moderate")
        self.assertEqual(n["lineRange"], [3, 9])
        self.assertEqual(n["name"], "run")

        # Edges rewritten, member-dangling edge dropped, nothing dangling.
        node_ids = set(ids)
        for e in g["edges"]:
            self.assertIn(e["source"], node_ids)
            self.assertIn(e["target"], node_ids)
        self.assertEqual(len(g["edges"]), 2 * 6)
        pairs = {(e["source"], e["target"], e["type"], e["weight"]) for e in g["edges"]}
        self.assertIn(("file:brain/src/main.ts", "function:brain/src/main.ts:run", "contains", 1.0), pairs)
        self.assertIn(("motor/bareid", "concept:motor/x", "related", 0.2), pairs)
        self.assertIn("file:brain/src/gone.ts", res.stderr)
        self.assertIn("file:motor/src/gone.ts", res.stderr)

        # Layers renamed and namespaced.
        layers = {l["id"]: l for l in g["layers"]}
        self.assertEqual(set(layers), {"layer:brain/api", "layer:brain/core",
                                       "layer:motor/api", "layer:motor/core"})
        self.assertEqual(layers["layer:motor/api"]["name"], "motor · API")
        self.assertEqual(layers["layer:motor/api"]["description"], "entry points")
        self.assertEqual(layers["layer:brain/api"]["nodeIds"],
                         ["file:brain/src/main.ts", "function:brain/src/main.ts:run"])

        # Tour: one leading step per member, manifest order, renumbered 1..N.
        tour = g["tour"]
        self.assertEqual(len(tour), 2 * (1 + 2))
        self.assertEqual([s["order"] for s in tour], list(range(1, 7)))
        self.assertEqual([s["title"] for s in tour], ["brain", "Start", "Run", "motor", "Start", "Run"])
        self.assertEqual(tour[0]["description"], "Brain service")
        self.assertEqual(tour[0]["nodeIds"], [])
        self.assertEqual(tour[3]["description"], "Motor service")
        self.assertEqual(tour[4]["nodeIds"], ["file:motor/src/main.ts"])
        self.assertEqual(tour[4]["languageLesson"], "ts lesson")
        self.assertEqual(tour[5]["nodeIds"], ["function:motor/src/main.ts:run", "config:motor/package.json"])

    def test_project_metadata(self) -> None:
        self._standard()
        res = self._run()
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._out("knowledge-graph.json")
        self.assertEqual(g["kind"], "codebase")
        self.assertEqual(g["version"], "1.0.0")  # first member's version
        p = g["project"]
        self.assertEqual(p["name"], "cloudbi")
        self.assertEqual(p["languages"], ["go", "python", "typescript"])
        self.assertEqual(p["frameworks"], ["Gin", "NestJS"])
        self.assertEqual(p["description"], "Workspace of 2 services: brain, motor")
        self.assertTrue(p["analyzedAt"])
        want_hash = "ws:" + hashlib.sha1("brain@aaa111\nmotor@bbb222".encode("utf-8")).hexdigest()
        self.assertEqual(p["gitCommitHash"], want_hash)
        ws = p["workspace"]
        self.assertEqual(ws["name"], "cloudbi")
        member_nodes = len(_member_graph(commit="", description="", languages=[], frameworks=[])["nodes"])
        self.assertEqual(ws["members"][0], {
            "name": "brain",
            "path": "../brain-repo",
            "gitCommitHash": "aaa111",
            "analyzedAt": "2026-10-01T10:00:00.000Z",
            "nodes": member_nodes,
            "edges": 7,
        })
        self.assertEqual([m["name"] for m in ws["members"]], ["brain", "motor"])
        # stdout: one line per member plus a total.
        self.assertIn("brain", res.stdout)
        self.assertIn("motor", res.stdout)
        self.assertIn("total", res.stdout.lower())

    def test_commit_hash_independent_of_manifest_order(self) -> None:
        self._standard(order=("brain", "motor"))
        self.assertEqual(self._run().returncode, 0)
        h1 = self._out("knowledge-graph.json")["project"]["gitCommitHash"]
        self._standard(order=("motor", "brain"))
        res = self._run()
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._out("knowledge-graph.json")
        self.assertEqual(g["project"]["gitCommitHash"], h1)
        self.assertEqual(g["version"], "2.0.0")  # first member is now motor
        self.assertEqual(g["tour"][0]["title"], "motor")

    def test_meta_json(self) -> None:
        self._standard()
        self.assertEqual(self._run().returncode, 0)
        g = self._out("knowledge-graph.json")
        meta = self._out("meta.json")
        self.assertIs(meta["workspace"], True)
        self.assertEqual(meta["gitCommitHash"], g["project"]["gitCommitHash"])
        self.assertEqual(meta["version"], g["version"])
        self.assertTrue(meta["lastAnalyzedAt"])
        # file-level nodes: file, config, document, service, pipeline, schema, resource
        self.assertEqual(meta["analyzedFiles"], 2 * 7)

    def test_config_output_language_copied_when_absent(self) -> None:
        self._standard()
        self.assertEqual(self._run().returncode, 0)
        self.assertEqual(self._out("config.json")["outputLanguage"], "pt-BR")

    def test_config_existing_output_language_is_kept(self) -> None:
        self._standard()
        (self.root / ".ua").mkdir()
        (self.root / ".ua" / "config.json").write_text(
            json.dumps({"outputLanguage": "es", "theme": "dark"}), encoding="utf-8")
        self.assertEqual(self._run().returncode, 0)
        self.assertEqual(self._out("config.json"), {"outputLanguage": "es", "theme": "dark"})

    def test_config_other_keys_preserved_when_language_added(self) -> None:
        self._standard()
        (self.root / ".ua").mkdir()
        (self.root / ".ua" / "config.json").write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
        self.assertEqual(self._run().returncode, 0)
        self.assertEqual(self._out("config.json"), {"theme": "dark", "outputLanguage": "pt-BR"})

    def test_legacy_member_data_dir_is_honored(self) -> None:
        self._standard(legacy_b=True)
        res = self._run()
        self.assertEqual(res.returncode, 0, res.stderr)
        ids = {n["id"] for n in self._out("knowledge-graph.json")["nodes"]}
        self.assertIn("file:motor/src/main.ts", ids)

    def test_rerun_is_deterministic_except_timestamps(self) -> None:
        self._standard()
        self.assertEqual(self._run().returncode, 0)
        g1 = self._out("knowledge-graph.json")
        self.assertEqual(self._run().returncode, 0)
        g2 = self._out("knowledge-graph.json")
        for g in (g1, g2):
            g["project"].pop("analyzedAt")
        self.assertEqual(g1, g2)

    def test_merge_function_direct(self) -> None:
        g = _member_graph(commit="c1", description="d", languages=["go"], frameworks=[])
        merged, report, dropped = mwg.merge_workspace(
            "solo", [({"name": "only", "path": "../only"}, g)])
        self.assertEqual(len(merged["nodes"]), len(g["nodes"]))
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["target"], "file:only/src/gone.ts")
        self.assertEqual(merged["project"]["description"], "Workspace of 1 services: only")


# ── Errors: exit ≠ 0 and nothing written ──────────────────────────────────

class TestWorkspaceErrors(_WorkspaceCase):
    def _ok_members(self) -> None:
        self._member("a-repo", _member_graph(commit="a", description="A", languages=[], frameworks=[]))
        self._member("b-repo", _member_graph(commit="b", description="B", languages=[], frameworks=[]))

    def _expect_failure(self, *needles: str) -> None:
        res = self._run()
        self.assertNotEqual(res.returncode, 0, res.stdout)
        for needle in needles:
            self.assertIn(needle, res.stderr)
        self._assert_nothing_written()

    def test_missing_manifest(self) -> None:
        self._expect_failure("ua-workspace.json")

    def test_unparsable_manifest(self) -> None:
        self._manifest("{nope")
        self._expect_failure("ua-workspace.json")

    def test_invalid_workspace_name(self) -> None:
        self._ok_members()
        for bad in ("Cloud_BI", "-x", "", None):
            with self.subTest(name=bad):
                manifest: dict[str, Any] = {"members": [{"name": "a", "path": "../a-repo"}]}
                if bad is not None:
                    manifest["name"] = bad
                self._manifest(manifest)
                self._expect_failure("name")

    def test_members_missing_or_empty(self) -> None:
        for members in (None, [], "x"):
            with self.subTest(members=members):
                manifest: dict[str, Any] = {"name": "ws"}
                if members is not None:
                    manifest["members"] = members
                self._manifest(manifest)
                self._expect_failure("members")

    def test_invalid_member_name(self) -> None:
        self._ok_members()
        self._manifest({"name": "ws", "members": [{"name": "A/b", "path": "../a-repo"}]})
        self._expect_failure("members[0].name")

    def test_duplicate_member_name(self) -> None:
        self._ok_members()
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "a", "path": "../b-repo"}]})
        self._expect_failure("members[1].name", "duplicate")

    def test_missing_member_path(self) -> None:
        self._ok_members()
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "b", "path": "../nope"}]})
        self._expect_failure("members[1].path", "nope")

    def test_member_path_field_missing(self) -> None:
        self._ok_members()
        self._manifest({"name": "ws", "members": [{"name": "a"}]})
        self._expect_failure("members[0].path")

    def test_same_dir_twice(self) -> None:
        self._ok_members()
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "b", "path": str(self.tmp / "a-repo")}]})
        self._expect_failure("members[1].path")

    def test_member_nested_in_another(self) -> None:
        self._ok_members()
        inner = self._member("a-repo/libs/inner",
                             _member_graph(commit="i", description="I", languages=[], frameworks=[]))
        self.assertTrue(inner.is_dir())
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "inner", "path": "../a-repo/libs/inner"}]})
        self._expect_failure("members[1].path")

    def test_missing_member_graph(self) -> None:
        self._ok_members()
        (self.tmp / "c-repo").mkdir()
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "c", "path": "../c-repo"}]})
        self._expect_failure("c", str(self.tmp.resolve() / "c-repo" / ".ua" / "knowledge-graph.json"))

    def test_unparsable_member_graph(self) -> None:
        self._ok_members()
        self._member("c-repo", None, raw="{broken")
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "c", "path": "../c-repo"}]})
        self._expect_failure("c", "knowledge-graph.json")

    def test_member_graph_without_arrays(self) -> None:
        self._ok_members()
        self._member("c-repo", {"project": {}})
        self._manifest({"name": "ws", "members": [
            {"name": "a", "path": "../a-repo"}, {"name": "c", "path": "../c-repo"}]})
        self._expect_failure("c")

    def test_duplicate_node_inside_member_breaks_invariant(self) -> None:
        dup = _node("concept:x", "concept")
        self._member("a-repo", _member_graph(commit="a", description="A", languages=[],
                                             frameworks=[], extra_nodes=[dup]))
        self._manifest({"name": "ws", "members": [{"name": "a", "path": "../a-repo"}]})
        self._expect_failure("concept:a/x")


class TestValidateOnly(_WorkspaceCase):
    """`--validate-only`: manifest check for the skill, before any member runs."""

    def test_valid_manifest_prints_members_and_writes_nothing(self) -> None:
        # Members exist but have no graph yet — that is fine before analysis.
        (self.tmp / "brain-repo").mkdir()
        (self.tmp / "motor-repo").mkdir()
        self._manifest({"name": "cloudbi", "members": [
            {"name": "brain", "path": "../brain-repo"},
            {"name": "motor", "path": "../motor-repo"}]})
        res = self._run("--validate-only")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout), {
            "name": "cloudbi",
            "members": [
                {"name": "brain", "path": "../brain-repo",
                 "dir": str((self.tmp / "brain-repo").resolve())},
                {"name": "motor", "path": "../motor-repo",
                 "dir": str((self.tmp / "motor-repo").resolve())},
            ],
        })
        self.assertFalse((self.root / ".ua").exists())

    def test_invalid_manifest_fails_naming_the_field(self) -> None:
        self._manifest({"name": "ws", "members": [{"name": "a", "path": "../nope"}]})
        res = self._run("--validate-only")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("members[0].path", res.stderr)
        self.assertFalse((self.root / ".ua").exists())

    def test_unknown_flag_is_rejected(self) -> None:
        self._manifest({"name": "ws", "members": [{"name": "a", "path": "../a"}]})
        res = self._run("--bogus")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("Usage", res.stderr)


if __name__ == "__main__":
    unittest.main()

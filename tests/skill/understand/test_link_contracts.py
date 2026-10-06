#!/usr/bin/env python3
"""
test_link_contracts.py — Tests for link-contracts.py, the deterministic
cross-service contract linker of a multi-repo workspace
(docs/multi-repo-workspace.md, "Cross-service contracts" → "Linking").

The member `contracts.json` fixtures are built by hand from the documented
schema (version 1); the scenario mirrors the CloudBI inventory: a base URL with
an embedded path suffix, an env re-pointed to a facade via a manifest binding
with a path prefix, an intentionally external binding, a catch-all that loses to
a literal route, a method mismatch, a glob queue subscription and tables touched
by one vs several members.

Run from the repo root:
    python -m unittest tests.skill.understand.test_link_contracts -v
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent.parent
_SKILL_DIR = _REPO_ROOT / "understand-anything-plugin" / "skills" / "understand"
_LINK_PATH = _SKILL_DIR / "link-contracts.py"
_MERGE_PATH = _SKILL_DIR / "merge-workspace-graphs.py"


def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lc = _load("link_contracts", _LINK_PATH)


# ── Fixture builders ──────────────────────────────────────────────────────

def _file_node(path: str) -> dict[str, Any]:
    return {"id": f"file:{path}", "type": "file", "name": path.rsplit("/", 1)[-1],
            "filePath": path, "summary": f"file {path}", "tags": ["code"], "complexity": "simple"}


def _graph(commit: str, files: list[str], *, extra_nodes: list[dict] | None = None,
           extra_edges: list[dict] | None = None) -> dict[str, Any]:
    nodes = [_file_node(f) for f in files] + (extra_nodes or [])
    return {
        "version": "1.0.0",
        "kind": "codebase",
        "project": {"name": "m", "languages": ["typescript"], "frameworks": [],
                    "description": "member", "analyzedAt": "2026-10-01T10:00:00.000Z",
                    "gitCommitHash": commit},
        "nodes": nodes,
        "edges": list(extra_edges or []),
        # One layer holding every node: the workspace graph is validated before it is written.
        "layers": [{"id": "layer:all", "name": "All", "description": "every node",
                    "nodeIds": [n["id"] for n in nodes]}],
        "tour": [],
    }


def _prov(method: str, route: str, file: str, line: int, *, catch_all: bool = False,
          order: int = 0, framework: str = "aspnet") -> dict[str, Any]:
    return {"kind": "http", "method": method, "route": route, "rawRoute": route,
            "framework": framework, "file": file, "line": line,
            "catchAll": catch_all, "order": order}


def _cons(method: str | None, path: str | None, file: str, line: int, *,
          base_name: str | None = None, base_type: str = "env", base_value: str | None = None,
          suffix: str = "", via: str = "axios", confidence: float = 0.9) -> dict[str, Any]:
    return {"kind": "http", "method": method, "path": path,
            "base": {"type": base_type, "name": base_name, "value": base_value, "suffix": suffix},
            "via": via, "file": file, "line": line, "confidence": confidence}


def _contracts(*, providers=(), consumers=(), publish=(), subscribe=(), reads=(), writes=(),
               env=(), services=()) -> dict[str, Any]:
    return {
        "version": 1,
        "providers": list(providers),
        "consumers": list(consumers),
        "messages": {"publish": list(publish), "subscribe": list(subscribe)},
        "tables": {"reads": list(reads), "writes": list(writes)},
        "env": list(env),
        "services": list(services),
        "stats": {"providers": len(providers), "consumers": len(consumers), "unresolvedConsumers": 0},
    }


def _env(name: str, value: str | None, source: str = "docker-compose.yml", line: int = 1,
         scope: str = "compose", **extra: Any) -> dict[str, Any]:
    return {"name": name, "value": value, "source": source, "line": line, "scope": scope, **extra}


GESTAO_OPS = "API/Controllers/OperacoesController.cs"
GESTAO_LOG5 = "API/Controllers/LogResumoArquivo5Controller.cs"
GESTAO_LEGADO = "API/Controllers/Fachada/LegadoRemovidoController.cs"
GESTAO_MOTOR = "API/Controllers/Fachada/MotorFechamentoController.cs"
GESTAO_MONITOR = "API/Controllers/MonitoringController.cs"
GESTAO_NUNCA = "API/Controllers/NuncaController.cs"
GESTAO_SELF = "API/Fachada/GerarExcel/GerarExcelNativo.cs"
GESTAO_BRAIN = "API/Fachada/Brain/BrainServico.cs"
GESTAO_FACHADA = "API/Fachada/Comum/FachadaOpcoes.cs"
GESTAO_LOGCFG = "API/Controllers/Data/Configuration/LogResumoConfiguration.cs"
GESTAO_OBRA = "API/Repository/OperacaoObraRepository.cs"

FRONT_OPS = "src/api/operacaoApi.js"
FRONT_LOG5 = "src/api/apiLogResumoArquivo5.js"
FRONT_CARGA = "src/components/CargaDoDia/useCargaDoDia.js"
FRONT_REF1 = "src/api/apiReferencia1.js"
FRONT_AUTH = "src/api/auth.js"
FRONT_FLUXO = "src/api/fluxo.js"
FRONT_COMISSOES = "src/api/RelatorioComissoes.js"
FRONT_MONITOR = "src/api/apiMonitoring.js"
FRONT_OBRAS = "src/api/obrasApi.js"
FRONT_STUB = "src/api/apiRelatorioMensal.js"

MOTOR_CTRL = "src/controller/carga_controller.py"
MOTOR_LOG = "src/repository/log_resumo/log_resumo.py"
MOTOR_SCRIPTS = "src/service/scripts.py"

EXCEL_CTRL = "Controllers/RelatorioComisoesController.cs"
EXCEL_HTTP = "HttpClients/GestaoOperacaoHttpClient.cs"
EXCEL_LOGCFG = "Data/Configuration/LogResumoConfiguration.cs"

BRAIN_PEDIDO = "src/worker_codeq/pedido.py"

# The member's own analysis already produced this endpoint node (+ routes edge):
# the linker must reuse it, never duplicate or delete it.
PREEXISTING_ENDPOINT = f"endpoint:{GESTAO_OPS}:GET /api/Operacoes/elegiveis"


def front_contracts() -> dict[str, Any]:
    G = "REACT_APP_API_GESTAO_OPERACAO"
    return _contracts(
        consumers=[
            # GT-01: base "…/api" + "/Operacoes/elegiveis"; literal must beat the templated {id}.
            _cons("GET", "/Operacoes/elegiveis", FRONT_OPS, 17, base_name=G),
            # templated provider route
            _cons("GET", "/Operacoes/42", FRONT_OPS, 30, base_name=G),
            # base value with an embedded path suffix (…/api/LogResumoArquivo5); case-insensitive match
            _cons("GET", "/GetAll", FRONT_LOG5, 10, base_name="REACT_APP_API_LOG_RESUMO_ARQUIVO5"),
            # binding with prefix: motor env re-pointed to the facade gestao:/api/motor — literal beats catch-all
            _cons("GET", "carga_do_dia", FRONT_CARGA, 33, base_name="REACT_APP_API_MOTOR_CALCULO",
                  via="superagent-wrapper"),
            # same binding, only the catch-all {**resto} matches
            _cons("GET", "/historico/referencia_1/x", FRONT_REF1, 68, base_name="REACT_APP_API_MOTOR_CALCULO"),
            # binding to external:<label>
            _cons("POST", "/login", FRONT_AUTH, 5, base_name="REACT_APP_API_AUTENTICACAO"),
            # env points to a port no member publishes
            _cons("GET", "/fluxo", FRONT_FLUXO, 3, base_name="REACT_APP_API_FLUXO_ESTRUTURACAO"),
            # resolved by published port 8095 → excel
            _cons("POST", "/Comisoes/Gerar", FRONT_COMISSOES, 25, base_name="REACT_APP_API_GERAR_EXCEL"),
            # exact path, wrong method → method-mismatch, not linked
            _cons("GET", "/Comisoes/Gerar", FRONT_COMISSOES, 30, base_name="REACT_APP_API_GERAR_EXCEL"),
            # un-normalized JS template in the consumer path → {} matches the provider template
            _cons("GET", "/Monitoring/streaming/sensor/${sensor}/history", FRONT_MONITOR, 70, base_name=G),
            # route removed from the provider
            _cons("GET", "/Obras/getObrasProUau", FRONT_OBRAS, 5, base_name=G),
            # unknown path
            _cons("GET", None, FRONT_STUB, 4, base_name=G),
        ],
        env=[
            _env(G, "http://172.16.50.47:8082/api", line=24),
            _env("REACT_APP_API_LOG_RESUMO_ARQUIVO5", "http://172.16.50.47:8082/api/LogResumoArquivo5", line=30),
            # versioned value points to the legacy motor; the manifest binding must win
            _env("REACT_APP_API_MOTOR_CALCULO", "http://172.16.50.47:8089/", line=26),
            _env("REACT_APP_API_AUTENTICACAO", "http://172.16.50.47:8083/", line=18),
            _env("REACT_APP_API_FLUXO_ESTRUTURACAO", "http://172.16.50.47:8098/", line=21),
            _env("REACT_APP_API_GERAR_EXCEL", "http://172.16.50.47:8095/", line=22),
            _env("REACT_APP_APIM_KEY", None, line=40, redacted=True),
        ],
    )


def gestao_contracts() -> dict[str, Any]:
    return _contracts(
        providers=[
            # templated route listed BEFORE the literal one: literal must still win
            _prov("GET", "/api/Operacoes/{}", GESTAO_OPS, 40),
            _prov("GET", "/api/Operacoes/elegiveis", GESTAO_OPS, 68),
            _prov("GET", "/api/LogResumoArquivo5/getall", GESTAO_LOG5, 20),
            _prov("ANY", "/api/motor/{}", GESTAO_LEGADO, 46, catch_all=True, order=2147483647),
            _prov("GET", "/api/motor/carga_do_dia", GESTAO_MOTOR, 80),
            _prov("GET", "/api/Monitoring/streaming/sensor/{}/history", GESTAO_MONITOR, 110),
            _prov("GET", "/api/Nunca/chamado", GESTAO_NUNCA, 5),
        ],
        consumers=[
            # self-call through the manifest env map (service-name host on the docker network)
            _cons("GET", "api/Operacoes/elegiveis", GESTAO_SELF, 61, base_name="APP_API_GESTAO_OPERACAO",
                  via="HttpClient"),
        ],
        publish=[
            {"channel": "brain-relatorio-detalhado", "system": "codeq", "file": GESTAO_BRAIN, "line": 43},
            {"channel": "brain-relatorio-consolidado", "system": "codeq", "file": GESTAO_BRAIN, "line": 44},
            {"channel": "cflow.executar", "system": "codeq", "file": GESTAO_FACHADA, "line": 42},
        ],
        writes=[
            {"table": "dbo.LOG_RESUMO", "file": GESTAO_MOTOR, "line": 193},
            {"table": "dbo.OperacaoObra", "file": GESTAO_OBRA, "line": 247},
            {"table": "dbo.Somente_Gestao", "file": GESTAO_OBRA, "line": 300},
        ],
        reads=[
            {"table": "[dbo].[LOG_RESUMO]", "file": GESTAO_LOGCFG, "line": 17},
            {"table": "dbo.Somente_Gestao", "file": GESTAO_LOGCFG, "line": 30},
        ],
        services=[{"name": "gestao-operacao", "ports": ["8082:8080"],
                   "hostnames": ["csfcloudbigestaooperacaodev.azurewebsites.net"],
                   "source": "docker-compose.yml", "line": 13}],
    )


def motor_contracts() -> dict[str, Any]:
    return _contracts(
        providers=[_prov("GET", "/carga_do_dia", MOTOR_CTRL, 10, framework="flask")],
        writes=[{"table": "dbo.LOG_RESUMO", "file": MOTOR_LOG, "line": 89}],
        reads=[{"table": "OperacaoObra", "file": MOTOR_SCRIPTS, "line": 48}],
        services=[{"name": "motor-calculo", "ports": ["8089:8089"], "hostnames": [],
                   "source": "docker-compose.yml", "line": 25}],
    )


def excel_contracts() -> dict[str, Any]:
    return _contracts(
        providers=[_prov("POST", "/Comisoes/Gerar", EXCEL_CTRL, 35)],
        consumers=[
            # resolved by the hostname gestao's services publish
            _cons("GET", "api/Operacoes/elegiveis", EXCEL_HTTP, 47, base_name="GESTAO_URL", via="HttpClient"),
        ],
        reads=[{"table": "dbo.LOG_RESUMO", "file": EXCEL_LOGCFG, "line": 12}],
        env=[_env("GESTAO_URL", "https://csfcloudbigestaooperacaodev.azurewebsites.net",
                  source=".env.example", scope="env-example")],
        services=[{"name": "gerar-excel", "ports": ["8095:80"], "hostnames": [],
                   "source": "docker-compose.yml", "line": 13}],
    )


def brain_contracts() -> dict[str, Any]:
    return _contracts(
        subscribe=[{"channel": "brain-relatorio-*", "system": "codeq", "file": BRAIN_PEDIDO, "line": 30}],
    )


MANIFEST_EXTRA = {
    "bindings": {
        "REACT_APP_API_MOTOR_CALCULO": "gestao:/api/motor",
        "REACT_APP_API_AUTENTICACAO": "external:autenticacao",
    },
    "env": {"APP_API_GESTAO_OPERACAO": "http://gestao-operacao:8080/"},
}


class _Workspace(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "ws"
        self.root.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _member(self, name: str, graph: dict[str, Any], contracts: dict[str, Any] | None) -> None:
        ua = self.tmp / f"{name}-repo" / ".ua"
        ua.mkdir(parents=True)
        (ua / "knowledge-graph.json").write_text(json.dumps(graph), encoding="utf-8")
        if contracts is not None:
            (ua / "contracts.json").write_text(json.dumps(contracts), encoding="utf-8")

    def _standard(self) -> None:
        self._member("front", _graph("f1", [FRONT_OPS, FRONT_LOG5, FRONT_CARGA, FRONT_REF1, FRONT_AUTH,
                                            FRONT_FLUXO, FRONT_COMISSOES, FRONT_MONITOR, FRONT_OBRAS,
                                            FRONT_STUB]), front_contracts())
        pre = {"id": PREEXISTING_ENDPOINT, "type": "endpoint", "name": "GET /api/Operacoes/elegiveis",
               "filePath": GESTAO_OPS, "summary": "from the member analysis", "tags": ["api"],
               "complexity": "simple"}
        pre_edge = {"source": f"file:{GESTAO_OPS}", "target": PREEXISTING_ENDPOINT, "type": "routes",
                    "direction": "forward", "weight": 0.8}
        self._member("gestao", _graph("g1", [GESTAO_OPS, GESTAO_LOG5, GESTAO_LEGADO, GESTAO_MOTOR,
                                             GESTAO_MONITOR, GESTAO_NUNCA, GESTAO_SELF, GESTAO_BRAIN,
                                             GESTAO_FACHADA, GESTAO_LOGCFG, GESTAO_OBRA],
                                      extra_nodes=[pre], extra_edges=[pre_edge]), gestao_contracts())
        self._member("motor", _graph("m1", [MOTOR_CTRL, MOTOR_LOG, MOTOR_SCRIPTS]), motor_contracts())
        self._member("excel", _graph("e1", [EXCEL_CTRL, EXCEL_HTTP, EXCEL_LOGCFG]), excel_contracts())
        self._member("brain", _graph("b1", [BRAIN_PEDIDO]), brain_contracts())
        self._member("docs", _graph("d1", ["README.md"]), None)  # no contracts.json → warn only
        names = ["front", "gestao", "motor", "excel", "brain", "docs"]
        manifest = {"name": "cloudbi",
                    "members": [{"name": n, "path": f"../{n}-repo"} for n in names],
                    **MANIFEST_EXTRA}
        (self.root / "ua-workspace.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _merge(self, *flags: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(_MERGE_PATH), str(self.root), *flags],
                              capture_output=True, text=True)

    def _link(self, *flags: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(_LINK_PATH), str(self.root), *flags],
                              capture_output=True, text=True)

    def _read(self, name: str) -> dict[str, Any]:
        return json.loads((self.root / ".ua" / name).read_text(encoding="utf-8"))

    def _bytes(self, name: str) -> bytes:
        return (self.root / ".ua" / name).read_bytes()


# ── Pure helpers ──────────────────────────────────────────────────────────

class TestNormalizeRoute(unittest.TestCase):
    def test_spec_rules(self) -> None:
        cases = {
            "http://h:1/api//x/?q=1#frag": "/api/x",
            "https://host.example.com": "/",
            "": "/",
            "/": "/",
            "api/Operacoes/": "/api/Operacoes",
            "/a/{id}/b": "/a/{}/b",
            "/a/{id:int}": "/a/{}",
            "/a/{**resto}": "/a/{}",
            "/a/:id/b": "/a/{}/b",
            "/a/<int:id>": "/a/{}",
            "/a/${sensor}/h": "/a/{}/h",
            "/a/${x ? `?c=${y}` : ''}": "/a/{}",
            "/a/{0}/b": "/a/{}/b",
            "/Keep/Case": "/Keep/Case",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(lc.normalize_route(raw), want)

    def test_catch_all_detection(self) -> None:
        self.assertTrue(lc.has_catch_all("/a/{**resto}"))
        self.assertTrue(lc.has_catch_all("/a/{*path}"))
        self.assertFalse(lc.has_catch_all("/a/{id}"))


class TestParseUrl(unittest.TestCase):
    def test_values(self) -> None:
        self.assertEqual(lc.parse_url("http://172.16.50.47:8082/api"), ("172.16.50.47", 8082, "/api"))
        self.assertEqual(lc.parse_url("http://172.16.50.47:8082/api/LogResumoArquivo5/"),
                         ("172.16.50.47", 8082, "/api/LogResumoArquivo5"))
        self.assertEqual(lc.parse_url("gestao-operacao:8080"), ("gestao-operacao", 8080, "/"))
        self.assertEqual(lc.parse_url("csf.azurewebsites.net/api"), ("csf.azurewebsites.net", None, "/api"))
        self.assertEqual(lc.parse_url("HTTPS://Host.Example.com"), ("host.example.com", None, "/"))
        self.assertIsNone(lc.parse_url("Colocar URL default da API AQUI"))
        self.assertIsNone(lc.parse_url(None))
        self.assertIsNone(lc.parse_url(""))

    def test_published_ports(self) -> None:
        self.assertEqual(lc.published_port("8082:8080"), 8082)
        self.assertEqual(lc.published_port("127.0.0.1:8082:8080"), 8082)
        self.assertEqual(lc.published_port("8089"), 8089)
        self.assertEqual(lc.published_port("8095/tcp"), 8095)
        self.assertEqual(lc.published_port("8082:8080/tcp"), 8082)
        self.assertIsNone(lc.published_port("${PORT}:80"))


class TestBindings(unittest.TestCase):
    def test_parse(self) -> None:
        self.assertEqual(lc.parse_binding("gestao:/api/motor"), ("member", "gestao", "/api/motor"))
        self.assertEqual(lc.parse_binding("gestao"), ("member", "gestao", ""))
        self.assertEqual(lc.parse_binding("external:autenticacao"), ("external", "autenticacao", ""))


class TestMatching(unittest.TestCase):
    def _p(self, method: str, route: str, line: int, **kw: Any) -> dict[str, Any]:
        return _prov(method, route, "F.cs", line, **kw)

    def test_literal_beats_template_beats_catch_all(self) -> None:
        provs = [self._p("ANY", "/api/{}", 1, catch_all=True),
                 self._p("GET", "/api/{}", 2),
                 self._p("GET", "/api/x", 3)]
        best, status = lc.match_provider("GET", "/api/x", provs)
        self.assertEqual((best["line"], status), (3, "linked"))
        best, status = lc.match_provider("GET", "/api/y", provs)
        self.assertEqual((best["line"], status), (2, "linked"))
        best, status = lc.match_provider("GET", "/api/y/z", provs)
        self.assertEqual((best["line"], status), (1, "linked"))

    def test_catch_all_matches_zero_or_more_segments(self) -> None:
        provs = [self._p("ANY", "/api/motor/{}", 1, catch_all=True)]
        self.assertEqual(lc.match_provider("GET", "/api/motor", provs)[1], "linked")
        self.assertEqual(lc.match_provider("GET", "/api/motor/a/b/c", provs)[1], "linked")
        self.assertEqual(lc.match_provider("GET", "/api/other", provs)[1], "no-route")

    def test_lower_order_wins_among_catch_alls(self) -> None:
        provs = [self._p("ANY", "/{}", 1, catch_all=True, order=10),
                 self._p("ANY", "/api/{}", 2, catch_all=True, order=1)]
        self.assertEqual(lc.match_provider("GET", "/api/x", provs)[0]["line"], 2)

    def test_tie_keeps_first_by_file_order(self) -> None:
        provs = [_prov("GET", "/x/{}", "b.cs", 1), _prov("GET", "/x/{}", "a.cs", 9),
                 _prov("GET", "/x/{}", "a.cs", 3)]
        best, _ = lc.match_provider("GET", "/x/1", provs)
        self.assertEqual((best["file"], best["line"]), ("a.cs", 3))

    def test_case_insensitive(self) -> None:
        provs = [self._p("get", "/API/Operacoes/Elegiveis", 1)]
        self.assertEqual(lc.match_provider("GET", "/api/operacoes/elegiveis", provs)[1], "linked")

    def test_consumer_template_only_matches_provider_template(self) -> None:
        provs = [self._p("GET", "/x/getall", 1)]
        self.assertEqual(lc.match_provider("GET", "/x/{}", provs)[1], "no-route")
        provs.append(self._p("GET", "/x/{}", 2))
        self.assertEqual(lc.match_provider("GET", "/x/{}", provs)[0]["line"], 2)

    def test_method_mismatch_is_reported_not_linked(self) -> None:
        provs = [self._p("POST", "/x", 1)]
        best, status = lc.match_provider("GET", "/x", provs)
        self.assertIsNone(best)
        self.assertEqual(status, "method-mismatch")

    def test_any_and_unknown_methods_are_compatible(self) -> None:
        self.assertEqual(lc.match_provider("DELETE", "/x", [self._p("ANY", "/x", 1)])[1], "linked")
        self.assertEqual(lc.match_provider(None, "/x", [self._p("POST", "/x", 1)])[1], "linked")


class TestChannels(unittest.TestCase):
    def test_glob(self) -> None:
        self.assertTrue(lc.channel_matches("brain-relatorio-*", "brain-relatorio-detalhado"))
        self.assertFalse(lc.channel_matches("brain-relatorio-*", "cflow.executar"))
        self.assertTrue(lc.channel_matches("cflow.executar", "cflow.executar"))


class TestTableKeys(unittest.TestCase):
    def test_quoting_and_case(self) -> None:
        self.assertEqual(lc.table_key("[dbo].[LOG_RESUMO]"), lc.table_key("dbo.log_resumo"))
        self.assertEqual(lc.clean_table("[dbo].[LOG_RESUMO]"), "dbo.LOG_RESUMO")
        self.assertEqual(lc.clean_table('"public"."users"'), "public.users")


# ── End-to-end through merge-workspace-graphs.py ──────────────────────────

class TestLinkEndToEnd(_Workspace):
    def setUp(self) -> None:
        super().setUp()
        self._standard()
        res = self._merge()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.res = res
        self.g = self._read("knowledge-graph.json")
        self.report = self._read("contracts-report.json")
        self.nodes = {n["id"]: n for n in self.g["nodes"]}

    def _edges(self, etype: str) -> set[tuple[str, str]]:
        return {(e["source"], e["target"]) for e in self.g["edges"] if e["type"] == etype}

    def _edge(self, src: str, tgt: str, etype: str) -> dict[str, Any]:
        found = [e for e in self.g["edges"]
                 if e["source"] == src and e["target"] == tgt and e["type"] == etype]
        self.assertEqual(len(found), 1, f"{etype} {src} -> {tgt}: {found}")
        return found[0]

    def test_missing_contracts_file_only_warns(self) -> None:
        self.assertIn("docs", self.res.stderr)
        self.assertIn("contracts.json", self.res.stderr)
        self.assertTrue(any("docs" in w for w in self.report["warnings"]))

    def test_endpoint_nodes_and_routes_edges(self) -> None:
        ep = {
            "elegiveis": f"endpoint:gestao/{GESTAO_OPS}:GET /api/Operacoes/elegiveis",
            "byid": f"endpoint:gestao/{GESTAO_OPS}:GET /api/Operacoes/{{}}",
            "log5": f"endpoint:gestao/{GESTAO_LOG5}:GET /api/LogResumoArquivo5/getall",
            "carga": f"endpoint:gestao/{GESTAO_MOTOR}:GET /api/motor/carga_do_dia",
            "legado": f"endpoint:gestao/{GESTAO_LEGADO}:ANY /api/motor/{{}}",
            "sensor": f"endpoint:gestao/{GESTAO_MONITOR}:GET /api/Monitoring/streaming/sensor/{{}}/history",
            "comissoes": f"endpoint:excel/{EXCEL_CTRL}:POST /Comisoes/Gerar",
        }
        endpoints = {nid for nid, n in self.nodes.items() if n["type"] == "endpoint"}
        self.assertEqual(endpoints, set(ep.values()))
        # Only matched routes become nodes: zero-consumer routes do not.
        self.assertNotIn(f"endpoint:gestao/{GESTAO_NUNCA}:GET /api/Nunca/chamado", self.nodes)
        self.assertNotIn(f"endpoint:motor/{MOTOR_CTRL}:GET /carga_do_dia", self.nodes)
        # The member's own endpoint node is reused, untouched.
        self.assertEqual(self.nodes[ep["elegiveis"]]["summary"], "from the member analysis")
        self.assertNotIn("generatedBy", self.nodes[ep["elegiveis"]])
        new = self.nodes[ep["comissoes"]]
        self.assertEqual(new["filePath"], f"excel/{EXCEL_CTRL}")
        self.assertEqual(new["lineRange"], [35, 35])
        self.assertEqual(new["name"], "POST /Comisoes/Gerar")
        for key in ("summary", "tags", "complexity"):
            self.assertIn(key, new)
        # routes: provider file → endpoint, exactly once each (pre-existing one not duplicated).
        routes = [e for e in self.g["edges"] if e["type"] == "routes"]
        self.assertEqual(len(routes), 7)
        self.assertEqual({(e["source"], e["target"]) for e in routes}, {
            (f"file:gestao/{GESTAO_OPS}", ep["elegiveis"]),
            (f"file:gestao/{GESTAO_OPS}", ep["byid"]),
            (f"file:gestao/{GESTAO_LOG5}", ep["log5"]),
            (f"file:gestao/{GESTAO_MOTOR}", ep["carga"]),
            (f"file:gestao/{GESTAO_LEGADO}", ep["legado"]),
            (f"file:gestao/{GESTAO_MONITOR}", ep["sensor"]),
            (f"file:excel/{EXCEL_CTRL}", ep["comissoes"]),
        })

    def test_calls_edges(self) -> None:
        g = f"endpoint:gestao/{GESTAO_OPS}:GET /api/Operacoes/elegiveis"
        want = {
            (f"file:front/{FRONT_OPS}", g),
            (f"file:front/{FRONT_OPS}", f"endpoint:gestao/{GESTAO_OPS}:GET /api/Operacoes/{{}}"),
            (f"file:front/{FRONT_LOG5}", f"endpoint:gestao/{GESTAO_LOG5}:GET /api/LogResumoArquivo5/getall"),
            (f"file:front/{FRONT_CARGA}", f"endpoint:gestao/{GESTAO_MOTOR}:GET /api/motor/carga_do_dia"),
            (f"file:front/{FRONT_REF1}", f"endpoint:gestao/{GESTAO_LEGADO}:ANY /api/motor/{{}}"),
            (f"file:front/{FRONT_COMISSOES}", f"endpoint:excel/{EXCEL_CTRL}:POST /Comisoes/Gerar"),
            (f"file:front/{FRONT_MONITOR}",
             f"endpoint:gestao/{GESTAO_MONITOR}:GET /api/Monitoring/streaming/sensor/{{}}/history"),
            (f"file:gestao/{GESTAO_SELF}", g),
            (f"file:excel/{EXCEL_HTTP}", g),
        }
        self.assertEqual(self._edges("calls"), want)
        e = self._edge(f"file:front/{FRONT_OPS}", g, "calls")
        self.assertIs(e["crossService"], True)
        self.assertEqual(e["direction"], "forward")
        self.assertTrue(0 < e["confidence"] <= 1)
        self.assertEqual(e["weight"], e["confidence"])
        self.assertEqual(e["evidence"]["consumer"], f"front/{FRONT_OPS}:17")
        self.assertEqual(e["evidence"]["provider"], f"gestao/{GESTAO_OPS}:68")
        self.assertEqual(e["evidence"]["via"], "axios")
        self.assertEqual(e["evidence"]["base"], "REACT_APP_API_GESTAO_OPERACAO")
        self.assertEqual(e["evidence"]["resolution"], "env")
        self.assertEqual(e["evidence"]["path"], "/api/Operacoes/elegiveis")

    def test_base_with_embedded_suffix(self) -> None:
        e = self._edge(f"file:front/{FRONT_LOG5}",
                       f"endpoint:gestao/{GESTAO_LOG5}:GET /api/LogResumoArquivo5/getall", "calls")
        self.assertEqual(e["evidence"]["path"], "/api/LogResumoArquivo5/GetAll")

    def test_binding_with_prefix_wins_over_env(self) -> None:
        e = self._edge(f"file:front/{FRONT_CARGA}",
                       f"endpoint:gestao/{GESTAO_MOTOR}:GET /api/motor/carga_do_dia", "calls")
        self.assertEqual(e["evidence"]["resolution"], "binding")
        self.assertEqual(e["evidence"]["path"], "/api/motor/carga_do_dia")
        self.assertEqual(e["evidence"]["via"], "superagent-wrapper")
        # The literal won; the catch-all only got the call that nothing else matches.
        catch = self._edge(f"file:front/{FRONT_REF1}", f"endpoint:gestao/{GESTAO_LEGADO}:ANY /api/motor/{{}}",
                           "calls")
        self.assertIs(catch["evidence"]["catchAll"], True)
        self.assertLess(catch["confidence"], e["confidence"])

    def test_manifest_env_and_hostname_resolution(self) -> None:
        g = f"endpoint:gestao/{GESTAO_OPS}:GET /api/Operacoes/elegiveis"
        self.assertEqual(self._edge(f"file:gestao/{GESTAO_SELF}", g, "calls")["evidence"]["resolution"],
                         "manifest-env")
        self.assertEqual(self._edge(f"file:excel/{EXCEL_HTTP}", g, "calls")["evidence"]["resolution"], "env")

    def test_messages(self) -> None:
        det = "concept:codeq/brain-relatorio-detalhado"
        con = "concept:codeq/brain-relatorio-consolidado"
        cfl = "concept:codeq/cflow.executar"
        for cid in (det, con, cfl):
            self.assertEqual(self.nodes[cid]["type"], "concept")
        self.assertEqual(self.nodes[det]["name"], "brain-relatorio-detalhado")
        self.assertEqual(self._edges("publishes"), {
            (f"file:gestao/{GESTAO_BRAIN}", det),
            (f"file:gestao/{GESTAO_BRAIN}", con),
            (f"file:gestao/{GESTAO_FACHADA}", cfl),
        })
        # glob subscription matches concrete channels only.
        self.assertEqual(self._edges("subscribes"), {
            (f"file:brain/{BRAIN_PEDIDO}", det),
            (f"file:brain/{BRAIN_PEDIDO}", con),
        })
        self.assertNotIn("concept:codeq/brain-relatorio-*", self.nodes)

    def test_tables_only_when_two_members_touch_them(self) -> None:
        log = "table:workspace/dbo.LOG_RESUMO"
        obra = "table:workspace/dbo.OperacaoObra"
        tables = {nid for nid, n in self.nodes.items() if nid.startswith("table:workspace/")}
        self.assertEqual(tables, {log, obra})
        self.assertEqual(self.nodes[log]["type"], "table")
        self.assertEqual(self._edges("writes_to"), {
            (f"file:gestao/{GESTAO_MOTOR}", log),
            (f"file:motor/{MOTOR_LOG}", log),
            (f"file:gestao/{GESTAO_OBRA}", obra),
        })
        self.assertEqual(self._edges("reads_from"), {
            (f"file:gestao/{GESTAO_LOGCFG}", log),
            (f"file:excel/{EXCEL_LOGCFG}", log),
            (f"file:motor/{MOTOR_SCRIPTS}", obra),
        })

    def test_invariant_and_meta(self) -> None:
        members = self.g["project"]["workspace"]["members"]
        contracts = self.g["project"]["workspace"]["contracts"]
        # 6 new endpoints (1 reused) + 3 channels + 2 tables
        self.assertEqual(contracts["nodes"], 11)
        # 6 routes + 9 calls + 5 messages + 6 tables
        self.assertEqual(contracts["edges"], 26)
        self.assertEqual(len(self.g["nodes"]), sum(m["nodes"] for m in members) + contracts["nodes"])
        generated = [n for n in self.g["nodes"] if n.get("generatedBy") == "link-contracts"]
        self.assertEqual(len(generated), contracts["nodes"])
        generated_edges = [e for e in self.g["edges"] if e.get("generatedBy") == "link-contracts"]
        self.assertEqual(len(generated_edges), contracts["edges"])
        meta = self._read("meta.json")
        file_level = {"file", "config", "document", "service", "pipeline", "schema", "resource"}
        self.assertEqual(meta["analyzedFiles"], sum(1 for n in self.g["nodes"] if n["type"] in file_level))
        # no dangling edges
        ids = set(self.nodes)
        for e in self.g["edges"]:
            self.assertIn(e["source"], ids)
            self.assertIn(e["target"], ids)

    def test_report(self) -> None:
        r = self.report
        self.assertEqual(r["version"], 1)
        self.assertEqual(r["coverage"], {"linked": 9, "eligible": 13, "ratio": 0.6923})
        pairs = {(p["consumer"], p["provider"]): p for p in r["pairs"]}
        self.assertEqual(set(pairs), {("front", "gestao"), ("front", "excel"),
                                      ("gestao", "gestao"), ("excel", "gestao")})
        self.assertEqual((pairs[("front", "gestao")]["linked"], pairs[("front", "gestao")]["unmatched"]), (6, 2))
        self.assertEqual((pairs[("front", "excel")]["linked"], pairs[("front", "excel")]["unmatched"]), (1, 1))
        self.assertEqual(pairs[("excel", "gestao")]["linked"], 1)
        self.assertEqual(pairs[("gestao", "gestao")]["linked"], 1)

        cons = r["consumers"]
        self.assertEqual(len(cons["linked"]), 9)
        unresolved = {(u["file"], u["reason"]) for u in cons["unresolved"]}
        self.assertEqual(unresolved, {(f"front/{FRONT_AUTH}", "external"),
                                      (f"front/{FRONT_FLUXO}", "no-binding")})
        ext = next(u for u in cons["unresolved"] if u["reason"] == "external")
        self.assertEqual(ext["target"], "external:autenticacao")
        unmatched = {(u["file"], u["line"], u["reason"]) for u in cons["unmatched"]}
        self.assertEqual(unmatched, {(f"front/{FRONT_COMISSOES}", 30, "method-mismatch"),
                                     (f"front/{FRONT_OBRAS}", 5, "no-route"),
                                     (f"front/{FRONT_STUB}", 4, "no-route")})
        mm = next(u for u in cons["unmatched"] if u["reason"] == "method-mismatch")
        self.assertEqual(mm["target"], "excel")
        self.assertEqual(mm["path"], "/Comisoes/Gerar")

        dead = {(p["member"], p["method"], p["route"]) for p in r["providersWithoutConsumers"]}
        self.assertEqual(dead, {("gestao", "GET", "/api/Nunca/chamado"),
                                ("motor", "GET", "/carga_do_dia")})

        self.assertEqual(r["linkedToCatchAll"], 1)
        chans = {c["id"]: c for c in r["messages"]["channels"]}
        self.assertEqual(chans["concept:codeq/brain-relatorio-detalhado"]["subscribers"],
                         [f"brain/{BRAIN_PEDIDO}:30"])
        self.assertEqual(chans["concept:codeq/cflow.executar"]["subscribers"], [])
        shared = {t["id"]: t for t in r["tables"]["shared"]}
        self.assertEqual(shared["table:workspace/dbo.LOG_RESUMO"]["members"], ["excel", "gestao", "motor"])
        self.assertEqual(r["tables"]["singleMember"], 1)  # dbo.Somente_Gestao

    def test_rerun_is_idempotent(self) -> None:
        g1, r1 = self._bytes("knowledge-graph.json"), self._bytes("contracts-report.json")
        for _ in range(2):
            res = self._link()
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(self._bytes("knowledge-graph.json"), g1)
            self.assertEqual(self._bytes("contracts-report.json"), r1)

    def test_rerun_replaces_previous_links_after_contract_change(self) -> None:
        # Drop every front consumer: its edges must disappear (replaced, not appended).
        c = front_contracts()
        c["consumers"] = []
        (self.tmp / "front-repo" / ".ua" / "contracts.json").write_text(json.dumps(c), encoding="utf-8")
        res = self._link()
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._read("knowledge-graph.json")
        calls = {(e["source"], e["target"]) for e in g["edges"] if e["type"] == "calls"}
        self.assertEqual(len(calls), 2)  # gestao self-call + excel → gestao
        ids = [n["id"] for n in g["nodes"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn(PREEXISTING_ENDPOINT.replace("endpoint:", "endpoint:gestao/"), ids)
        self.assertNotIn(f"endpoint:excel/{EXCEL_CTRL}:POST /Comisoes/Gerar", ids)
        ws = g["project"]["workspace"]
        self.assertEqual(len(g["nodes"]), sum(m["nodes"] for m in ws["members"]) + ws["contracts"]["nodes"])


    def test_contracts_layer(self) -> None:
        layers = [l for l in self.g["layers"] if l["id"] == "layer:workspace/contratos"]
        self.assertEqual(len(layers), 1)
        layer = layers[0]
        self.assertEqual(layer["name"], "Contratos entre serviços")
        self.assertTrue(layer["description"])
        generated = sorted(n["id"] for n in self.g["nodes"] if n.get("generatedBy") == "link-contracts")
        self.assertEqual(layer["nodeIds"], generated)
        self.assertEqual({self.nodes[i]["type"] for i in generated}, {"endpoint", "concept", "table"})
        # The member's own endpoint node keeps its member layer and is not duplicated.
        pre = PREEXISTING_ENDPOINT.replace("endpoint:", "endpoint:gestao/")
        self.assertNotIn(pre, layer["nodeIds"])
        gestao_layer = next(l for l in self.g["layers"] if l["id"] == "layer:gestao/all")
        self.assertIn(pre, gestao_layer["nodeIds"])
        # Every file-level node (plugin's fileLevelTypes) in exactly one layer; whole graph valid.
        owners: dict[str, list[str]] = {}
        for l in self.g["layers"]:
            for nid in l["nodeIds"]:
                owners.setdefault(nid, []).append(l["id"])
        for n in self.g["nodes"]:
            if n["type"] in lc._mwg.LAYERED_TYPES:
                self.assertEqual(len(owners.get(n["id"], [])), 1, n["id"])
        self.assertEqual(lc._mwg.validate_workspace_graph(self.g), [])

    def test_contracts_layer_is_rebuilt_and_dropped_when_empty(self) -> None:
        c = front_contracts()
        c["consumers"] = []
        (self.tmp / "front-repo" / ".ua" / "contracts.json").write_text(json.dumps(c), encoding="utf-8")
        self.assertEqual(self._link().returncode, 0)
        g = self._read("knowledge-graph.json")
        layers = [l for l in g["layers"] if l["id"] == "layer:workspace/contratos"]
        self.assertEqual(len(layers), 1)
        self.assertEqual(layers[0]["nodeIds"],
                         sorted(n["id"] for n in g["nodes"] if n.get("generatedBy") == "link-contracts"))

        for name in ("front", "gestao", "motor", "excel", "brain"):
            (self.tmp / f"{name}-repo" / ".ua" / "contracts.json").write_text(
                json.dumps(_contracts()), encoding="utf-8")
        res = self._link()
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._read("knowledge-graph.json")
        self.assertFalse(any(l["id"] == "layer:workspace/contratos" for l in g["layers"]))
        self.assertEqual(g["project"]["workspace"]["contracts"], {"nodes": 0, "edges": 0})
        self.assertFalse(any(n.get("generatedBy") for n in g["nodes"]))

    def test_standalone_link_refuses_invalid_graph_and_writes_nothing(self) -> None:
        g = self._read("knowledge-graph.json")
        g["layers"] = [l for l in g["layers"] if l["id"] != "layer:motor/all"]
        (self.root / ".ua" / "knowledge-graph.json").write_text(json.dumps(g), encoding="utf-8")
        before = self._bytes("knowledge-graph.json"), self._bytes("contracts-report.json")
        res = self._link()
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("fails validation", res.stderr)
        self.assertIn(f"file:motor/{MOTOR_CTRL}' is not in any layer", res.stderr)
        self.assertEqual((self._bytes("knowledge-graph.json"), self._bytes("contracts-report.json")), before)


class TestNoContractsFlag(_Workspace):
    def test_merge_without_linking(self) -> None:
        self._standard()
        res = self._merge("--no-contracts")
        self.assertEqual(res.returncode, 0, res.stderr)
        g = self._read("knowledge-graph.json")
        self.assertFalse(any(n.get("generatedBy") == "link-contracts" for n in g["nodes"]))
        self.assertFalse(any(e.get("crossService") for e in g["edges"]))
        self.assertNotIn("contracts", g["project"]["workspace"])
        self.assertFalse((self.root / ".ua" / "contracts-report.json").exists())

    def test_no_contracts_after_linked_merge_leaves_nothing_stale(self) -> None:
        self._standard()
        self.assertEqual(self._merge().returncode, 0)
        self.assertTrue((self.root / ".ua" / "contracts-report.json").exists())
        res = self._merge("--no-contracts")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertFalse((self.root / ".ua" / "contracts-report.json").exists())
        g = self._read("knowledge-graph.json")
        self.assertFalse(any(n.get("generatedBy") for n in g["nodes"]))
        self.assertFalse(any(e.get("generatedBy") for e in g["edges"]))
        self.assertFalse(any(l["id"] == "layer:workspace/contratos" for l in g["layers"]))
        ws = g["project"]["workspace"]
        self.assertNotIn("contracts", ws)
        self.assertEqual(len(g["nodes"]), sum(m["nodes"] for m in ws["members"]))
        self.assertEqual(lc._mwg.validate_workspace_graph(g), [])

    def test_link_requires_merged_graph(self) -> None:
        self._standard()
        res = self._link()
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("knowledge-graph.json", res.stderr)


if __name__ == "__main__":
    unittest.main()

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../../understand-anything-plugin/skills/understand/extract-contracts.mjs');
const FIXTURES = resolve(__dirname, 'fixtures/contracts');

const tempDirs = [];

/**
 * Copy a fixture member to a temp dir (no git there → recursive walk path).
 * Files named `dot-env*` become `.env*` (the repo's .gitignore ignores `.env.*`,
 * so the fixture cannot carry the real name).
 */
function materialize(name) {
  const root = mkdtempSync(join(tmpdir(), `ua-contracts-${name}-`));
  tempDirs.push(root);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.startsWith('dot-env')) renameSync(abs, join(dir, entry.replace(/^dot-/, '.')));
    }
  };
  walk(root);
  return root;
}

function run(root, extraArgs = []) {
  const result = spawnSync('node', [SCRIPT, root, ...extraArgs], { encoding: 'utf-8' });
  return result;
}

function extract(name) {
  const root = materialize(name);
  const result = run(root);
  if (result.status !== 0) throw new Error(`extract-contracts failed: ${result.stderr}`);
  const text = readFileSync(join(root, '.ua', 'contracts.json'), 'utf-8');
  return { root, text, data: JSON.parse(text), stderr: result.stderr };
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const provider = (data, method, route) =>
  data.providers.find((p) => p.method === method && p.route === route);
const providersAt = (data, route) => data.providers.filter((p) => p.route === route);
const consumer = (data, file, method, path) =>
  data.consumers.find((c) => c.file === file && c.method === method && c.path === path);
const consumersIn = (data, file) => data.consumers.filter((c) => c.file === file);

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

describe('extract-contracts CLI', () => {
  it('exits non-zero without a member root', () => {
    const result = spawnSync('node', [SCRIPT], { encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/i);
  });

  it('honors --out and writes schema version 1 with stats', () => {
    const root = materialize('python');
    const out = join(root, 'custom-out.json');
    const result = run(root, ['--out', out]);
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(root, '.ua', 'contracts.json'))).toBe(false);
    const data = JSON.parse(readFileSync(out, 'utf-8'));
    expect(data.version).toBe(1);
    for (const key of ['providers', 'consumers', 'env', 'services']) expect(Array.isArray(data[key])).toBe(true);
    expect(Array.isArray(data.messages.publish)).toBe(true);
    expect(Array.isArray(data.messages.subscribe)).toBe(true);
    expect(Array.isArray(data.tables.reads)).toBe(true);
    expect(Array.isArray(data.tables.writes)).toBe(true);
    expect(data.stats.providers).toBe(data.providers.length);
    expect(data.stats.consumers).toBe(data.consumers.length);
  });

  it('is deterministic (byte-identical output on re-run)', () => {
    const root = materialize('react');
    run(root);
    const first = readFileSync(join(root, '.ua', 'contracts.json'), 'utf-8');
    run(root);
    expect(readFileSync(join(root, '.ua', 'contracts.json'), 'utf-8')).toBe(first);
  });

  it('honors .understandignore', () => {
    const root = materialize('python');
    writeFileSync(join(root, '.understandignore'), 'src/flask_app.py\n');
    const result = run(root);
    expect(result.status).toBe(0);
    const data = JSON.parse(readFileSync(join(root, '.ua', 'contracts.json'), 'utf-8'));
    expect(data.providers.some((p) => p.file === 'src/flask_app.py')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ASP.NET Core member
// ---------------------------------------------------------------------------

describe('ASP.NET Core member', () => {
  let data;
  let text;
  beforeAll(() => {
    ({ data, text } = extract('aspnet'));
  });

  it('composes [Route("api/[controller]")] + [HttpGet("x")] from the class name', () => {
    const p = provider(data, 'GET', '/api/Pedidos/elegiveis');
    expect(p).toBeDefined();
    expect(p.framework).toBe('aspnet');
    expect(p.file).toBe('Api/Controllers/PedidosController.cs');
    expect(p.line).toBe(10);
    expect(p.rawRoute).toBe('elegiveis');
    expect(p.symbol).toBe('PedidosController.Elegiveis');
  });

  it('ignores commented-out attributes and test projects', () => {
    expect(providersAt(data, '/api/Pedidos/comentado')).toHaveLength(0);
    expect(providersAt(data, '/api/Fake/nao-conta')).toHaveLength(0);
  });

  it('uses the class route for verb attributes without template', () => {
    expect(provider(data, 'GET', '/api/Pedidos')).toBeDefined();
  });

  it('normalizes constrained parameters to {}', () => {
    const p = provider(data, 'POST', '/api/Pedidos/{}/aprovar');
    expect(p).toBeDefined();
    expect(p.rawRoute).toBe('{id:int}/aprovar');
  });

  it('replaces [action] with the method name minus Async', () => {
    expect(provider(data, 'GET', '/api/Pedidos/Resumo')).toBeDefined();
  });

  it('takes [controller] from the class, not the file name, and ignores a leading slash on the class route', () => {
    const p = provider(data, 'GET', '/api/EstruturadorMails/getall');
    expect(p).toBeDefined();
    expect(p.file).toBe('Api/Controllers/EmailsDoEstruturador.cs');
  });

  it('lets an absolute action template discard the class route', () => {
    expect(provider(data, 'GET', '/GetParametros')).toBeDefined();
    expect(provider(data, 'GET', '/Parametros/Listar')).toBeDefined();
  });

  it('resolves const strings used in attributes and routes without class route as absolute', () => {
    expect(provider(data, 'POST', '/RelatorioAntecipacoes/GravarRelatorio')).toBeDefined();
    expect(provider(data, 'DELETE', '/RelatorioAntecipacoes/ExcluirRelatorio')).toBeDefined();
    expect(provider(data, 'POST', '/api/TesteEmail/EnviarConsolidado')).toBeDefined();
    expect(provider(data, 'POST', '/api/excel/GerarConsolidado/relatorio')).toBeDefined();
    expect(provider(data, 'GET', '/api/consolidado/bilhetagem')).toBeDefined();
  });

  it('flags catch-alls with their Order', () => {
    const p = provider(data, 'ANY', '/api/motor/{}');
    expect(p).toBeDefined();
    expect(p.catchAll).toBe(true);
    expect(p.order).toBe(2147483647);
    expect(p.rawRoute).toBe('api/motor/{**resto}');
  });

  it('applies a statically recognizable IApplicationModelConvention prefix to its assembly only', () => {
    expect(provider(data, 'GET', '/api/excel/GetContas')).toBeDefined();
    expect(provider(data, 'POST', '/api/excel/Exportar/Gerar')).toBeDefined();
    expect(provider(data, 'GET', '/GetContas')).toBeUndefined();
    // controllers outside the Portado project are untouched
    expect(provider(data, 'GET', '/GetParametros')).toBeDefined();
  });

  it('extracts minimal APIs including MapGroup and MapHealthChecks', () => {
    expect(provider(data, 'GET', '/healthz')).toBeDefined();
    expect(provider(data, 'GET', '/ping')).toBeDefined();
    expect(provider(data, 'POST', '/v1/eventos/{}')).toBeDefined();
  });

  it('resolves typed clients registered with AddHttpClient + BaseAddress from env', () => {
    const c = consumer(data, 'Api/Clientes/GestaoHttpClient.cs', 'GET', '/api/Pedidos/elegiveis');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'APP_API_GESTAO' });
    expect(c.via).toBe('typed-client');
    expect(c.line).toBe(17);
  });

  it('resolves BaseAddress through an options property read from env (confidence < 1)', () => {
    const exec = consumer(data, 'Api/Clientes/CflowCliente.cs', 'POST', '/pipelines/{}/executar');
    expect(exec).toBeDefined();
    expect(exec.base).toMatchObject({ type: 'env', name: 'CFLOW_API' });
    expect(exec.confidence).toBeLessThan(1);
  });

  it('follows C# helpers that build HttpRequestMessage from a parameter (method literal or parameter)', () => {
    expect(consumer(data, 'Api/Clientes/CflowCliente.cs', 'GET', '/execucoes/{}')).toBeDefined();
    expect(consumer(data, 'Api/Clientes/CflowCliente.cs', 'PUT', '/v1/tarefas')).toBeDefined();
    // the helper bodies themselves are not consumers
    expect(consumersIn(data, 'Api/Clientes/CflowCliente.cs')).toHaveLength(3);
  });

  it('reads BaseAddress from IConfiguration for typed clients', () => {
    const c = consumer(data, 'Api/Clientes/RelatorioClient.cs', 'POST', '/relatorios/gerar');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'config', name: 'Servicos:Relatorio' });
  });

  it('handles new HttpClient with BaseAddress from env and full literal URLs; skips non-HttpClient GetAsync', () => {
    const motor = consumer(data, 'Api/Servicos/MotorServico.cs', 'GET', '/referencia_1/explosao/gerar_excel');
    expect(motor).toBeDefined();
    expect(motor.base).toMatchObject({ type: 'env', name: 'URL_API_MOTOR' });
    const ext = consumer(data, 'Api/Servicos/MotorServico.cs', 'GET', '/ws/01001000/json');
    expect(ext).toBeDefined();
    expect(ext.base).toMatchObject({ type: 'literal', value: 'https://viacep.example.com' });
    expect(consumersIn(data, 'Api/Servicos/MotorServico.cs')).toHaveLength(2);
  });

  it('resolves helper calls whose URL comes from a static property backed by env', () => {
    const c = consumer(data, 'Api/Servicos/DataFetcher.cs', 'POST', '/query');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'API_DUCKDB' });
    expect(c.line).toBe(10);
  });

  it('extracts CodeQ commands and broker publishes', () => {
    const pub = data.messages.publish.map((m) => `${m.system}:${m.channel}`);
    expect(pub).toContain('codeq:brain-relatorio-detalhado');
    expect(pub).toContain('codeq:brain-relatorio-consolidado');
    expect(pub).toContain('codeq:cflow.executar');
    expect(pub).toContain('kafka:pedidos-criados');
    expect(pub).toContain('rabbitmq:fila-cargas');
    expect(pub.some((p) => p.includes('CODEQ_TOPICO_RELATORIO'))).toBe(false);
  });

  it('extracts tables from ORM attributes, fluent mapping and SQL literals', () => {
    const reads = data.tables.reads.map((t) => t.table);
    const writes = data.tables.writes.map((t) => t.table);
    expect(reads).toContain('dbo.Operacao');
    expect(reads).toContain('dbo.LOG_RESUMO');
    expect(reads).toContain('dbo.Operacao_fn');
    expect(reads).toContain('dbo.OperacaoObra');
    expect(writes).toContain('dbo.LOG_RESUMO');
    expect(reads).not.toContain('o.Data');
    expect(reads).not.toContain('the');
  });

  it('extracts env (URL-like only) and services; redacts secrets', () => {
    const env = Object.fromEntries(data.env.map((e) => [`${e.scope}:${e.name}`, e]));
    expect(env['compose:CFLOW_API'].value).toBe('https://cflow.local:8443');
    expect(env['compose:BUILD_URL'].value).toBe('http://builder.local:9000');
    expect(env['compose:DB_PASSWORD']).toMatchObject({ value: null, redacted: true });
    expect(env['compose:ConnectionStrings__Default']).toMatchObject({ value: null, redacted: true });
    expect(env['compose:LOG_LEVEL']).toBeUndefined();
    expect(env['appsettings:Urls'].value).toBe('http://0.0.0.0:8080');
    expect(env['appsettings:Servicos:Relatorio'].value).toBe('http://relatorio:7000/');
    expect(env['appsettings:ConnectionStrings:Default']).toMatchObject({ value: null, redacted: true });
    expect(env['appsettings:Jwt:Key']).toMatchObject({ value: null, redacted: true });
    expect(env['env-example:CODEQ_URL'].value).toBe('http://codeq:8080');
    expect(env['env-example:TRINO'].value).toBe('172.16.50.47:5004');
    expect(env['env-example:CODEQ_PRODUCER_TOKEN']).toMatchObject({ value: null, redacted: true });
    expect(env['env-example:ACCESS_JWT']).toMatchObject({ value: null, redacted: true });
    expect(text).not.toMatch(/supersecret/);
    expect(text).not.toMatch(/eyJhbGci/);
    const svc = data.services.find((s) => s.name === 'loja-api');
    expect(svc).toMatchObject({ ports: ['8082:8080'], source: 'docker-compose.yml' });
    expect(svc.hostnames).toContain('loja-api.interno');
  });
});

// ---------------------------------------------------------------------------
// Python member (FastAPI / Flask / http.server / requests / httpx)
// ---------------------------------------------------------------------------

describe('Python member', () => {
  let data;
  let text;
  beforeAll(() => {
    ({ data, text } = extract('python'));
  });

  it('extracts FastAPI routes of included routers, including multi-line decorators', () => {
    const p = provider(data, 'GET', '/referencia_1/explosao/gerar_excel');
    expect(p).toMatchObject({ framework: 'fastapi', file: 'src/controller/ref_controller.py', line: 6 });
    const multi = provider(data, 'GET', '/referencia_5/total_previsto');
    expect(multi).toMatchObject({ line: 11 });
    expect(provider(data, 'POST', '/itens/{}')).toBeDefined();
    expect(provider(data, 'GET', '/multi')).toBeDefined();
    expect(provider(data, 'POST', '/multi')).toBeDefined();
    expect(provider(data, 'GET', '/livez')).toBeDefined();
  });

  it('composes include_router(prefix=) with APIRouter(prefix=)', () => {
    expect(provider(data, 'GET', '/hist/v1/referencia_9/explosao')).toBeDefined();
  });

  it('skips routers that are never included when the member mounts routers explicitly', () => {
    expect(providersAt(data, '/path/to/ping')).toHaveLength(0);
  });

  it('extracts Flask routes and blueprint url_prefix', () => {
    expect(provider(data, 'GET', '/status')).toMatchObject({ framework: 'flask' });
    expect(provider(data, 'GET', '/bp/itens/{}')).toBeDefined();
    expect(provider(data, 'DELETE', '/bp/itens/{}')).toBeDefined();
  });

  it('extracts http.server literal paths', () => {
    const p = data.providers.find((x) => x.framework === 'http.server');
    expect(p).toMatchObject({ method: 'GET', route: '/livez', file: 'src/worker/saude.py' });
  });

  it('extracts OpenAPI paths x methods', () => {
    const routes = data.providers.filter((x) => x.framework === 'openapi').map((x) => `${x.method} ${x.route}`);
    expect(routes.sort()).toEqual(['GET /pets', 'GET /pets/{}', 'POST /pets']);
  });

  it('ignores test files', () => {
    expect(providersAt(data, '/nao-conta')).toHaveLength(0);
    expect(data.consumers.some((c) => c.file.startsWith('tests/'))).toBe(false);
  });

  it('resolves requests with str.format (named and positional) and env bases', () => {
    const auth = consumer(data, 'src/adapter/auth.py', 'GET', '/api/Users/validarToken');
    expect(auth).toBeDefined();
    expect(auth.base).toMatchObject({ type: 'env', name: 'ROUTE_AUTENTICACAO' });
    expect(auth.via).toBe('requests');
    const salvar = consumer(data, 'src/adapter/auth.py', 'POST', '/Pedidos/salvar');
    expect(salvar.base).toMatchObject({ type: 'env', name: 'API_GESTAO' });
  });

  it('resolves Session receivers, f-strings and helper methods; base via config attribute (guessed)', () => {
    const pub = consumer(data, 'src/adapter/cflow.py', 'GET', '/publicados/{}/{}');
    expect(pub).toBeDefined();
    expect(pub.base).toMatchObject({ type: 'env', name: 'CFLOW_URL' });
    expect(pub.confidence).toBeLessThan(1);
    expect(consumer(data, 'src/adapter/cflow.py', 'GET', '/execucoes/{}')).toBeDefined();
    // resp.headers.get(...) is not an HTTP call; the helper body is not a consumer
    expect(consumersIn(data, 'src/adapter/cflow.py')).toHaveLength(2);
  });

  it('resolves httpx.Client(base_url=...) receivers', () => {
    const c = consumer(data, 'third_party/fila_sdk/cliente.py', 'POST', '/v1/codeq/tasks/claim');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'CODEQ_URL' });
    expect(c.via).toBe('httpx');
  });

  it('extracts CodeQ subscriptions (TOPICOS constants + commands=) and broker channels', () => {
    const sub = data.messages.subscribe.map((m) => `${m.system}:${m.channel}`);
    expect(sub).toContain('codeq:brain-relatorio-detalhado');
    expect(sub).toContain('codeq:brain-relatorio-consolidado');
    expect(sub).toContain('codeq:cflow.executar');
    expect(sub).toContain('codeq:cflow.antecipacao');
    expect(sub).toContain('kafka:pedidos-criados');
    expect(sub).toContain('rabbitmq:fila-cargas');
    expect(sub).toContain('redis:canal-precos');
    const pub = data.messages.publish.map((m) => `${m.system}:${m.channel}`);
    expect(pub).toContain('kafka:pedidos-criados');
    expect(pub).toContain('rabbitmq:fila-cargas');
    expect(pub).toContain('redis:canal-precos');
  });

  it('classifies table reads and writes from SQL literals, .sql files and ORM', () => {
    const reads = data.tables.reads.map((t) => t.table);
    const writes = data.tables.writes.map((t) => t.table);
    expect(reads).toContain('VD_VENDAS');
    expect(reads).toContain('vd_conta_recebida');
    expect(reads).toContain('dbo.Operacao_fn');
    expect(reads).toContain('OperacaoObra');
    expect(reads).toContain('stage.VD_VENDAS_NOVAS');
    expect(writes).toContain('dbo.LOG_RESUMO');
    expect(writes).toContain('dbo.VD_VENDAS');
    expect(writes).toContain('stage.VD_VENDAS_NOVAS');
    expect(reads).not.toContain('comentario_ignorado');
    // `from x import y` is code, not SQL
    expect(reads).not.toContain('sqlalchemy');
    const insert = data.tables.writes.find((t) => t.table === 'dbo.LOG_RESUMO' && t.file === 'src/adapter/repositorio.py');
    expect(insert.line).toBe(16);
  });

  it('extracts k8s ConfigMap/Deployment env, Dockerfile ARG/ENV and services', () => {
    const env = Object.fromEntries(data.env.map((e) => [`${e.scope}:${e.name}`, e]));
    expect(env['k8s:CFLOW_URL'].value).toBe('https://172.16.50.121:8443');
    expect(env['k8s:CFLOW_TOKEN']).toMatchObject({ value: null, redacted: true });
    expect(env['k8s:CODEQ_URL'].value).toBe('http://codeq:8080');
    expect(env['k8s:LOG_LEVEL']).toBeUndefined();
    expect(env['dockerfile:API_BASE'].value).toBe('http://api:8000');
    expect(env['dockerfile:MOTOR_URL'].value).toBe('http://motor:8089');
    expect(env['dockerfile:SEM_VALOR']).toBeUndefined();
    expect(text).not.toMatch(/supersecret/);
    const svc = data.services.find((s) => s.name === 'motor-svc');
    expect(svc.ports).toEqual(['80:8089']);
    expect(data.services.find((s) => s.name === 'motor').ports).toEqual(['8089']);
  });
});

// ---------------------------------------------------------------------------
// React / Node member
// ---------------------------------------------------------------------------

describe('JS/TS member', () => {
  let data;
  let text;
  beforeAll(() => {
    ({ data, text } = extract('react'));
  });

  it('resolves superagent wrapper modules (requests.get) to the imported env base', () => {
    const c = consumer(data, 'src/api/operacaoApi.js', 'GET', '/Operacoes/elegiveis');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', suffix: '' });
    expect(c.via).toBe('superagent-wrapper');
    expect(c.line).toBe(9);
    expect(consumer(data, 'src/api/operacaoApi.js', 'GET', '/Operacoes/getall')).toBeDefined();
    expect(consumer(data, 'src/api/operacaoApi.js', 'GET', '/Operacoes/getbyid')).toBeDefined();
    expect(consumer(data, 'src/api/operacaoApi.js', 'GET', '/GrupoRoles/operacoesGrupo/{}')).toBeDefined();
    expect(consumer(data, 'src/api/operacaoApi.js', 'POST', '/Operacoes/AdicionarOperacao')).toBeDefined();
    expect(consumer(data, 'src/api/operacaoApi.js', 'DELETE', '/Operacoes/{}')).toBeDefined();
  });

  it('does not report wrapper method bodies as consumers, but reports fixed-URL calls inside them', () => {
    const inWrapper = consumersIn(data, 'src/api/apiGestao.js');
    expect(inWrapper).toHaveLength(1);
    expect(inWrapper[0]).toMatchObject({ method: 'GET', path: '/Repasse/ExportarPlanilha', via: 'superagent' });
  });

  it('follows import aliases and baseUrl bare imports; keeps the base suffix', () => {
    const c = consumer(data, 'src/components/Carga/useCarga.js', 'GET', '/carga_do_dia');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', suffix: '/motor' });
    expect(c.confidence).toBeLessThan(1);
  });

  it('follows default-import wrappers (agent.requests.post) and normalizeUrl', () => {
    const c = consumer(data, 'src/components/Login.jsx', 'POST', '/Users/login');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_AUTENTICACAO' });
  });

  it('resolves axios.create({ baseURL }) instances', () => {
    const c = consumer(data, 'src/api/apiEstruturadora.js', 'GET', '/EstruturadorMails/getall');
    expect(c).toMatchObject({ via: 'axios.create' });
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO' });
    expect(consumer(data, 'src/api/apiEstruturadora.js', 'PUT', '/EmailEstruturador/Deletar')).toBeDefined();
  });

  it('resolves axios direct, axios({url, method}) and missing method (GET)', () => {
    const file = 'src/api/RelatorioComissoes.js';
    const post = consumer(data, file, 'POST', '/Comisoes/Gerar');
    expect(post).toMatchObject({ via: 'axios' });
    expect(post.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GERAR_EXCEL' });
    expect(consumer(data, file, 'GET', '/Comisoes/Exportar/{}')).toBeDefined();
    expect(consumer(data, file, 'GET', '/Comisoes/Listar')).toBeDefined();
    expect(consumer(data, file, 'DELETE', '/Comisoes/{}')).toBeDefined();
    expect(consumersIn(data, file)).toHaveLength(4);
  });

  it('resolves fetch with a re-exported base constant and method from options', () => {
    const c = consumer(data, 'src/components/Upload/UploadLastro.jsx', 'POST', '/Lastro/UploadFile');
    expect(c).toMatchObject({ via: 'fetch' });
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO' });
  });

  it('resolves helpers that receive the URL (and method) as arguments', () => {
    const file = 'src/components/ModalReferencia1.jsx';
    const get = consumer(data, file, 'GET', '/ExportarExplosao/Referencia1');
    expect(get).toMatchObject({ via: 'helper' });
    expect(get.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GERAR_EXCEL' });
    expect(consumer(data, file, 'POST', '/ExportarBases')).toBeDefined();
    expect(consumersIn(data, 'src/assets/functions/DownloadExcel.js')).toHaveLength(0);
  });

  it('resolves dedup helpers and URL-builder functions', () => {
    const file = 'src/api/apiMonitoring.js';
    expect(consumer(data, file, 'GET', '/Monitoring/streaming/summary')).toBeDefined();
    const hist = consumer(data, file, 'GET', '/Monitoring/streaming/sensor/{}/history');
    expect(hist).toBeDefined();
    expect(hist.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO' });
    expect(consumersIn(data, file)).toHaveLength(2);
  });

  it('keeps a path prefix embedded in the base constant as suffix', () => {
    const c = consumer(data, 'src/api/apiBoletos.js', 'GET', '/filtros');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', suffix: '/boletos' });
    expect(consumer(data, 'src/api/apiBoletos.js', 'GET', '/{}')).toBeDefined();
  });

  it('evaluates URL builders with env fallbacks (A || B)', () => {
    const c = consumer(data, 'src/api/apiConferencia.js', 'GET', '/api/Conferencia/GetTotaisByOperation');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_CARGA', fallbacks: ['REACT_APP_API_GESTAO'] });
  });

  it('resolves constants with an embedded path passed to axios({ url })', () => {
    const c = consumer(data, 'src/api/apiAntecipacoes.js', 'GET', '/RelatorioAntecipacoes/DownloadExcelResumo');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_ANTECIPACOES' });
  });

  it('handles TypeScript annotations and import.meta.env', () => {
    expect(consumer(data, 'src/api/apiRoles.ts', 'GET', '/roles')).toBeDefined();
    const del = consumer(data, 'src/api/apiRoles.ts', 'DELETE', '/roles/{}');
    expect(del.base).toMatchObject({ type: 'env', name: 'VITE_API_ROLES' });
  });

  it('ignores test files', () => {
    expect(data.consumers.some((c) => c.file.includes('__tests__'))).toBe(false);
  });

  it('extracts Express and NestJS providers', () => {
    expect(provider(data, 'GET', '/api/users/{}')).toMatchObject({ framework: 'express' });
    expect(provider(data, 'POST', '/api/users')).toBeDefined();
    expect(provider(data, 'GET', '/health')).toBeDefined();
    expect(provider(data, 'GET', '/v1/cats/{}')).toMatchObject({ framework: 'nestjs', symbol: 'CatsController.findOne' });
    expect(provider(data, 'POST', '/v1/cats')).toBeDefined();
  });

  it('extracts kafkajs / amqplib channels', () => {
    const pub = data.messages.publish.map((m) => `${m.system}:${m.channel}`);
    const sub = data.messages.subscribe.map((m) => `${m.system}:${m.channel}`);
    expect(pub).toContain('kafka:eventos-pedido');
    expect(sub).toContain('kafka:eventos-pedido');
    expect(pub).toContain('rabbitmq:fila-relatorios');
    expect(sub).toContain('rabbitmq:fila-relatorios');
  });

  it('extracts build args, .env.example and redacts keys', () => {
    const env = Object.fromEntries(data.env.map((e) => [`${e.scope}:${e.name}`, e]));
    expect(env['compose:REACT_APP_API_GESTAO'].value).toBe('http://172.16.50.47:8082/api');
    expect(env['env-example:REACT_APP_API_GESTAO'].value).toBe('http://172.16.50.47:8082/api');
    expect(env['env-example:REACT_APP_APIM_KEY']).toMatchObject({ value: null, redacted: true });
    expect(env['compose:PUBLIC_URL']).toBeUndefined();
    expect(text).not.toMatch(/supersecret/);
    expect(data.services.find((s) => s.name === 'front').ports).toEqual(['8001:8080']);
  });

  it('counts unresolved consumers in stats', () => {
    const unresolved = data.consumers.filter((c) => c.path === null || c.base.type === 'unknown').length;
    expect(data.stats.unresolvedConsumers).toBe(unresolved);
  });
});

// ---------------------------------------------------------------------------
// Base transforms: a base derived from an env base by a string transform
// ---------------------------------------------------------------------------

describe('base transforms', () => {
  let data;
  beforeAll(() => {
    ({ data } = extract('base-transform'));
  });
  const variante = (name) => consumer(data, 'src/api/variantes.js', 'GET', `/Variante/${name}`);

  it('records stripSuffix for a helper that does .replace(/\\/api$/, "") (wrapper consumers)', () => {
    const post = consumer(data, 'src/api/Relatorio.js', 'POST', '/Relatorio/IniciarGravacao');
    expect(post).toBeDefined();
    expect(post.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', suffix: '', transform: { stripSuffix: '/api' } });
    const get = consumer(data, 'src/api/Relatorio.js', 'GET', '/Relatorio/Percentual');
    expect(get.base.transform).toEqual({ stripSuffix: '/api' });
  });

  it('keeps the transform through a module constant with an embedded path (axios({ url }))', () => {
    const c = consumer(data, 'src/assets/functions/DownloadResumo.js', 'GET', '/Relatorio/DownloadResumo');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', transform: { stripSuffix: '/api' } });
  });

  it('records no transform when the base is used as-is', () => {
    const c = variante('sem-barra');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO' });
    expect(c.base.transform).toBeUndefined();
    const motor = consumer(data, 'src/api/variantes.js', 'GET', '/calcular');
    expect(motor.base).toMatchObject({ suffix: '/motor' });
    expect(motor.base.transform).toBeUndefined();
  });

  it('applies a transform to a literal tail instead of the base', () => {
    const c = variante('cauda');
    expect(c).toBeDefined();
    expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', suffix: '' });
    expect(c.base.transform).toBeUndefined();
  });

  it('recognizes .replace("/api", ""), template .replace(regex) and new URL(x).origin', () => {
    expect(variante('string').base.transform).toEqual({ stripSuffix: '/api' });
    expect(variante('template').base.transform).toEqual({ stripSuffix: '/api' });
    const origin = variante('origin');
    expect(origin).toBeDefined();
    expect(origin.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO', transform: { origin: true } });
  });

  it('marks unrecognized transforms as unknown with lower confidence', () => {
    const plain = variante('sem-barra');
    for (const name of ['slice', 'odd']) {
      const c = variante(name);
      expect(c, name).toBeDefined();
      expect(c.base).toMatchObject({ type: 'env', name: 'REACT_APP_API_GESTAO' });
      expect(c.base.transform.unknown).toBe(true);
      expect(c.confidence).toBeLessThan(plain.confidence);
    }
  });
});

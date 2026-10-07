import { requests } from './apiGestao';

const _inflight = new Map();

function dedupedGet(url) {
  if (_inflight.has(url)) return _inflight.get(url);
  const p = requests.get(url).finally(() => _inflight.delete(url));
  _inflight.set(url, p);
  return p;
}

function buildSensorHistoryUrl(sensor, tabela) {
  const qs = new URLSearchParams({ tabela: String(tabela) });
  return `/Monitoring/streaming/sensor/${encodeURIComponent(sensor)}/history?${qs.toString()}`;
}

const apiMonitoring = {
  getSummary: () => dedupedGet('/Monitoring/streaming/summary'),
  getSensorHistory: (sensor, tabela) => dedupedGet(buildSensorHistoryUrl(sensor, tabela)),
};

export default apiMonitoring;

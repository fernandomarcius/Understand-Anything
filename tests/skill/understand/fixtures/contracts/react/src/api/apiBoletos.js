import { REACT_APP_API_GESTAO } from '../config'

const BASE = `${REACT_APP_API_GESTAO}/boletos`

async function getJson(caminho, filtros, signal) {
  const query = filtros ? new URLSearchParams(filtros).toString() : ''
  const res = await fetch(`${BASE}${caminho}${query ? `?${query}` : ''}`, { signal })
  return res.json()
}

const apiBoletos = {
  getFiltros: (signal) => getJson('/filtros', null, signal),
  getLista: (recurso, filtros, signal) => getJson(`/${recurso}`, filtros, signal),
}

export default apiBoletos

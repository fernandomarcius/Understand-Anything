import superagent from 'superagent'
import { REACT_APP_API_CARGA, REACT_APP_API_GESTAO } from '../config'

const API_CARGA = REACT_APP_API_CARGA || REACT_APP_API_GESTAO

const normalizeBaseUrl = (url = '') => String(url).trim().replace(/\/+$/, '')

const buildCargaUrl = (endpointPath) => {
  const base = normalizeBaseUrl(API_CARGA)
  if (!base || base === 'undefined') {
    throw new Error('Configuração ausente')
  }
  if (base.endsWith('/api')) {
    return `${base}${endpointPath}`
  }
  return `${base}/api${endpointPath}`
}

const apiConferencia = {
  buscarTotais: async (operacaoId) => {
    const url = buildCargaUrl('/Conferencia/GetTotaisByOperation')
    const res = await superagent.get(url).query({ operacao: operacaoId })
    return res.body
  },
}

export default apiConferencia

import { REACT_APP_API_GESTAO } from '../config'

const semBarraFinal = (url) => String(url ?? '').trim().replace(/\/+$/, '')

export const baseApiFachada = (gestao = REACT_APP_API_GESTAO) => {
  const base = semBarraFinal(gestao)
  if (!base || base === 'undefined') {
    return ''
  }
  return base.endsWith('/api') ? base : `${base}/api`
}

export const FACHADA_MOTOR = `${baseApiFachada()}/motor/`

import { REACT_APP_API_GESTAO } from '../config'

// Synthetic mirror of a real pattern: the env value ends with `/api`, and one family of
// routes lives at the host root, so the base is derived by stripping that `/api`.
const semBarraFinal = (url) => String(url ?? '').trim().replace(/\/+$/, '')

export const baseApiFachada = (gestao = REACT_APP_API_GESTAO) => {
  const base = semBarraFinal(gestao)
  if (!base || base === 'undefined') {
    return ''
  }
  return base.endsWith('/api') ? base : `${base}/api`
}

export const raizFachada = (gestao = REACT_APP_API_GESTAO) =>
  baseApiFachada(gestao).replace(/\/api$/, '')

export const FACHADA_MOTOR = `${baseApiFachada()}/motor/`
export const FACHADA_RAIZ = raizFachada()

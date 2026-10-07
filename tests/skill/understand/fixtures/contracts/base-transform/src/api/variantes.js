import { FACHADA_MOTOR } from './fachada'

const API = process.env.REACT_APP_API_GESTAO

const RAIZ_STR = API.replace('/api', '')
const RAIZ_TPL = `${API}`.replace(/\/api$/, '')
const RAIZ_ORIGIN = new URL(API).origin
const RAIZ_SLICE = API.slice(0, -4)
const RAIZ_ODD = API.replace(/v\d+/, 'v2')
const SEM_BARRA = API.replace(/\/+$/, '').trim()
const COM_CAUDA = `${API}/api`.replace(/\/api$/, '')

export const viaString = () => fetch(`${RAIZ_STR}/Variante/string`)
export const viaTemplate = () => fetch(`${RAIZ_TPL}/Variante/template`)
export const viaOrigin = () => fetch(`${RAIZ_ORIGIN}/Variante/origin`)
export const viaSlice = () => fetch(`${RAIZ_SLICE}/Variante/slice`)
export const viaOdd = () => fetch(`${RAIZ_ODD}/Variante/odd`)
export const semBarra = () => fetch(`${SEM_BARRA}/Variante/sem-barra`)
export const comCauda = () => fetch(`${COM_CAUDA}/Variante/cauda`)
export const motor = () => fetch(`${FACHADA_MOTOR}calcular`)

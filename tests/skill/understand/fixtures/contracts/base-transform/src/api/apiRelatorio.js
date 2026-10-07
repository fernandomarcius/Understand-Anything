import superagent from 'superagent'
import { FACHADA_RAIZ } from './fachada'

export const API_ROOT = FACHADA_RAIZ
export const URL_RESUMO = API_ROOT + '/Relatorio/DownloadResumo?'

const responseBody = (res) => res.body

export const requests = {
  get: (url) => superagent.get(`${API_ROOT}${url}`).then(responseBody),
  post: (url, body) => superagent.post(`${API_ROOT}${url}`, body).then(responseBody),
}

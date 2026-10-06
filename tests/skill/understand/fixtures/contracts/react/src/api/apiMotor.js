import superagent from 'superagent'
import { FACHADA_MOTOR } from './fachada'

export const API_ROOT = FACHADA_MOTOR

export const requests = {
  get: (url) => superagent.get(`${API_ROOT}${url}`).then((res) => res.body),
  getBlob: (url) => superagent.get(`${API_ROOT}${url}`).responseType('blob').then((res) => res.body),
}

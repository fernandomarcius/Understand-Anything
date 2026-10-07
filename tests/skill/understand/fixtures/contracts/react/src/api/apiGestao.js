import superagent from 'superagent'
import { REACT_APP_API_GESTAO } from '../config'

const API_ROOT = REACT_APP_API_GESTAO
// const API_ROOT = 'https://localhost:7003/api';

const responseBody = (res) => res.body

const tokenPlugin = (req) => {
  const token = window.sessionStorage.getItem('jwt')
  if (token) req.set('authorization', `Bearer ${token}`)
}

export const requests = {
  del: (url) => superagent.del(`${API_ROOT}${url}`).use(tokenPlugin).then(responseBody),
  get: (url) =>
    superagent.get(`${API_ROOT}${url}`).use(tokenPlugin).then(responseBody),
  put: (url, body) => superagent.put(`${API_ROOT}${url}`, body).use(tokenPlugin).then(responseBody),
  post: (url, body, options = {}) => {
    const request = superagent
      .post(`${API_ROOT}${url}`, body)
      .use(tokenPlugin)
    return request.then(responseBody)
  },
  exportarPlanilha: (ano) =>
    superagent
      .get(`${API_ROOT}/Repasse/ExportarPlanilha`)
      .query({ ano })
      .then((res) => res.body),
}

export default {
  requests,
}

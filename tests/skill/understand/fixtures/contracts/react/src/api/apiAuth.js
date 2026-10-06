import superagent from 'superagent'
import { REACT_APP_API_AUTENTICACAO } from '../config'

const API_ROOT = REACT_APP_API_AUTENTICACAO

const normalizeUrl = (baseUrl, path) => {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
};

export const requests = {
  get: (url) => superagent.get(normalizeUrl(API_ROOT, url)).then((res) => res.body),
  post: (url, body) => superagent.post(normalizeUrl(API_ROOT, url)).send(body).then((res) => res.body),
}

export default {
  requests,
  setToken: (_token) => {},
}

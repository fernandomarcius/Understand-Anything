import axios from 'axios'
import { URL_RESUMO } from 'api/apiRelatorio'

export const baixarResumo = (params) =>
  axios({ url: URL_RESUMO + params, method: 'GET', responseType: 'blob' })

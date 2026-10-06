import axios from 'axios'

export const API_ROOT = process.env.REACT_APP_API_ANTECIPACOES
export const URL_RESUMO = API_ROOT + '/RelatorioAntecipacoes/DownloadExcelResumo?'

export const baixarResumo = (params) =>
  axios({ url: URL_RESUMO + params, method: 'GET', responseType: 'blob' })

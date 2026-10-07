import { requests } from './apiGestao'

const operacao = {
  getAll: () => requests.get('/Operacoes/getall'),
  getElegiveis: ({ competencia } = {}) => {
    const params = []
    if (competencia) params.push(`competencia=${encodeURIComponent(competencia)}`)
    const qs = params.length ? `?${params.join('&')}` : ''
    return requests.get(`/Operacoes/elegiveis${qs}`)
  },
  getById: (id) => requests.get(`/Operacoes/getbyid?Id=${id}`),
  porGrupo: (email) => requests.get(`/GrupoRoles/operacoesGrupo/${email}`),
  postOperacao: (nova) => requests.post('/Operacoes/AdicionarOperacao', nova),
  del: (id) => requests.del(`/Operacoes/${id}`),
}

export default operacao

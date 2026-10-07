import { requests } from 'api/apiRelatorio'

const relatorio = {
  iniciar: (data) => requests.post('/Relatorio/IniciarGravacao', data),
  percentual: (key) => requests.get(`/Relatorio/Percentual?key=${encodeURIComponent(key)}`),
}

export default relatorio

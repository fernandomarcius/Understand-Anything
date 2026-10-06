import axios from 'axios'

const API_BASE_URL = process.env.REACT_APP_API_GERAR_EXCEL

const relatorioComissoes = {
  postGerar: async (data) => {
    const res = await axios.post(`${API_BASE_URL}Comisoes/Gerar`, data);
    return res.data;
  },
  getExportar: async (id) => {
    const res = await axios({
      url: `${API_BASE_URL}Comisoes/Exportar/${id}`,
      method: 'GET',
      responseType: 'blob',
    });
    return res;
  },
  semMetodo: async () => axios({ url: `${API_BASE_URL}Comisoes/Listar` }),
  remover: async (id) => axios.delete(`${API_BASE_URL}Comisoes/${id}`),
  downloadExcel: (blob) => window.URL.createObjectURL(new Blob([blob])),
}

export default relatorioComissoes

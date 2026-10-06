import axios from 'axios';

export const downloadExcel = async (rota, nome_arquivo, endpoint, finalizar, handleError, token = '', amethod = 'GET') => {
  const response = await axios({
    url: endpoint,
    method: amethod,
    responseType: 'blob',
  });
  return response;
};

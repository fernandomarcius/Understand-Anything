import axios from 'axios'

const API_ROOT = process.env.REACT_APP_API_GESTAO

const apiClient = axios.create({
  baseURL: API_ROOT,
  headers: { 'Content-Type': 'application/json' },
})

export const estruturadorMailsApi = {
  getAll: () => apiClient.get('EstruturadorMails/getall'),
  deletar: (e) => apiClient.put(`EmailEstruturador/Deletar?Id=${e.id}`),
}

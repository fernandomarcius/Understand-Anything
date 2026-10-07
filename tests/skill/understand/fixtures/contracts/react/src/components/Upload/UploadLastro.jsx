import React from 'react'
import { API_GESTAO_OPERACAO } from 'api/apiUpload'

export default function UploadLastro({ operacaoId }) {
  const enviar = async (formData) => {
    const response = await fetch(`${API_GESTAO_OPERACAO}/Lastro/UploadFile?operacaoId=${operacaoId}`, {
      method: 'POST',
      body: formData,
    })
    return response.ok
  }
  return <input type="file" onChange={(e) => enviar(e.target.files)} />
}

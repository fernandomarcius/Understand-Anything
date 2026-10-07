import React from 'react'
import { downloadExcel } from '../assets/functions/DownloadExcel'

const API_ROOT_EXCEL = process.env.REACT_APP_API_GERAR_EXCEL

export default function ModalReferencia1({ obra }) {
  const baixar = () => {
    const parametros = `ExportarExplosao/Referencia1?obra=${obra}`
    const endpoint = API_ROOT_EXCEL + parametros
    downloadExcel('excelRef1', 'titulo', endpoint, null, null)
  }
  const enviar = () => downloadExcel('x', 'y', `${API_ROOT_EXCEL}ExportarBases`, null, null, '', 'POST')
  return <button onClick={baixar} onDoubleClick={enviar}>Baixar</button>
}

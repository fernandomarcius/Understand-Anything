import { useCallback } from 'react'
import { requests as requestsMotor } from 'api/apiMotor'

export function useCarga(operacaoId, comp) {
  return useCallback(async () => {
    const resposta = await requestsMotor.get(`carga_do_dia?operacao_id=${operacaoId}&competencia=${comp}`)
    return resposta
  }, [operacaoId, comp])
}

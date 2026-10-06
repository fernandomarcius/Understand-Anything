from typing import Optional
from urllib.parse import quote

import requests


class CflowCliente:
    def __init__(self, configuracao, sessao: Optional[requests.Session] = None):
        self._cfg = configuracao
        self._sessao = sessao or requests.Session()

    def publicado(self, dataset):
        url = f"{self._cfg.url}/publicados/{quote('gold')}/{quote(dataset, safe='/')}"
        resp = self._sessao.get(url, stream=True, timeout=30)
        resp.headers.get("Content-Length")
        return resp

    def execucao(self, execucao_id):
        caminho = f"{self._cfg.url}/execucoes/{execucao_id}"
        return self._get(caminho, [])

    def _get(self, url: str, params: list):
        return self._sessao.get(url, params=params, timeout=30)

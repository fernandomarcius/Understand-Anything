import os
import requests


def autenticar(token):
    ROUTE_AUTENTICACAO = os.getenv('ROUTE_AUTENTICACAO')
    route = """{ROUTE_AUTENTICACAO}/api/Users/validarToken?token={token}""".format(ROUTE_AUTENTICACAO=ROUTE_AUTENTICACAO, token=token)
    resposta = requests.get(route)
    return resposta.status_code == 200


def salvar(dados):
    base = os.environ["API_GESTAO"]
    return requests.post("{}/Pedidos/salvar".format(base), json=dados)

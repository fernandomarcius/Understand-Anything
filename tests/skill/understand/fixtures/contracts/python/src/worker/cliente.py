from third_party.fila_sdk.cliente import FilaClient


class ClienteWorker:
    def __init__(self):
        self._sdk = FilaClient()

    def reivindicar(self, topicos, lease):
        return self._sdk.claim_task(ClaimTaskOptions(commands=list(topicos), lease_seconds=lease))

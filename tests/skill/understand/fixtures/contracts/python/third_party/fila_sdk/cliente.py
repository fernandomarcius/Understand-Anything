import os

import httpx


class FilaClient:
    def __init__(self):
        self._client = httpx.Client(base_url=os.getenv("CODEQ_URL"))

    def claim_task(self, options):
        return self._client.post("/v1/codeq/tasks/claim", json=options)

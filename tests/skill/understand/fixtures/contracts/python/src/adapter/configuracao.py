import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ConfiguracaoCflow:
    url: str
    token: str

    @staticmethod
    def do_ambiente(env=os.environ):
        url = (env.get("CFLOW_URL") or "").strip()
        token = env.get("CFLOW_TOKEN") or ""
        return ConfiguracaoCflow(url, token)

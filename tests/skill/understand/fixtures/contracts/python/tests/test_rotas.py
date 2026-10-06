import requests
from fastapi import APIRouter

router = APIRouter()


@router.get("/nao-conta")
def nada():
    return requests.get("http://localhost:9999/nao-conta")

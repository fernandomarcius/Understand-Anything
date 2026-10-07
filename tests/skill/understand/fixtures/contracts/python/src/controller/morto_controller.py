from fastapi import APIRouter

router = APIRouter()


@router.get("/path/to/ping")
def ping():
    return "pong"

from fastapi import APIRouter

router = APIRouter(prefix="/v1")


@router.get("/referencia_9/explosao")
def explosao():
    return None

from fastapi import APIRouter

router = APIRouter()


@router.get("/referencia_1/explosao/gerar_excel")
def gerar_excel(obraid: str):
    return None


@router.get(
    "/referencia_5/total_previsto", tags=["Referencia 5"]
)
def total_previsto():
    return None


@router.post("/itens/{item_id}")
async def criar_item(item_id: int):
    return None


@router.api_route("/multi", methods=["GET", "POST"])
def multi():
    return None

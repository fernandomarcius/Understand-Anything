from src.controller.ref_controller import router as ROUTER_REF
from src.controller import hist_controller
from src.web.app import app


def aplicar_rotas():
    app.include_router(ROUTER_REF)
    app.include_router(hist_controller.router, prefix="/hist")

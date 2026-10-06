from fastapi import FastAPI

app = FastAPI(title="motor")


@app.get("/livez")
def livez():
    return {"ok": True}

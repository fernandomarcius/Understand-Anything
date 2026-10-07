from flask import Flask, Blueprint

app = Flask(__name__)
bp = Blueprint("itens", __name__, url_prefix="/bp")


@app.route("/status")
def status():
    return "ok"


@bp.route("/itens/<int:item_id>", methods=["GET", "DELETE"])
def item(item_id):
    return "ok"


app.register_blueprint(bp)

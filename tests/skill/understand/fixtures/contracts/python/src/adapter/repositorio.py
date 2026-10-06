from sqlalchemy import Column, Integer, MetaData, Table, text
from sqlalchemy.orm import declarative_base

Base = declarative_base()
metadata = MetaData()


class VdVendas(Base):
    __tablename__ = "VD_VENDAS"
    id = Column(Integer, primary_key=True)


contas = Table("vd_conta_recebida", metadata, Column("id", Integer))

INSERIR = """
INSERT INTO dbo.LOG_RESUMO (operacao_id, ativo)
VALUES (?, 1)
"""


def ler(sessao, data):
    return sessao.execute(text(f"SELECT a.* FROM dbo.Operacao_fn('{data}') a LEFT JOIN OperacaoObra oo ON oo.id = a.id"))

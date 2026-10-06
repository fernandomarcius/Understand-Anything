-- SELECT * FROM comentario_ignorado
MERGE INTO dbo.VD_VENDAS AS alvo
USING stage.VD_VENDAS_NOVAS AS origem ON alvo.id = origem.id
WHEN MATCHED THEN UPDATE SET alvo.valor = origem.valor;

TRUNCATE TABLE stage.VD_VENDAS_NOVAS;
DELETE FROM dbo.LOG_RESUMO WHERE ativo = 0;

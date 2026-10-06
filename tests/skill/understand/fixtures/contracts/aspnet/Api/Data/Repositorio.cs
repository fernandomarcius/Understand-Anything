namespace Loja.Api.Data;

public class Repositorio
{
    public string Desativar = "UPDATE dbo.LOG_RESUMO SET ativo = 0 WHERE id = @id";

    public string Listar(string data) => $@"
        SELECT o.*, oo.Obra
          FROM dbo.Operacao_fn(@data) o
          JOIN [dbo].[OperacaoObra] oo ON oo.OperacaoId = o.Id
         WHERE EXTRACT(YEAR FROM o.Data) = 2026";

    public const string Mensagem = "Selecione uma operação from the list";
}

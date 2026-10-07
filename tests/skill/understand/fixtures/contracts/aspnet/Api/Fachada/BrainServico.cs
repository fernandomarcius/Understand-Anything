namespace Loja.Api.Fachada;

public sealed class BrainServico(ICodeqCliente codeq)
{
    public const string CommandDetalhado = "brain-relatorio-detalhado";
    public const string CommandConsolidado = "brain-relatorio-consolidado";
    public const string VariavelTopico = "CODEQ_TOPICO_RELATORIO";

    public Task Enfileirar(bool consolidado) =>
        codeq.CriarTaskAsync(consolidado ? CommandConsolidado : CommandDetalhado);
}

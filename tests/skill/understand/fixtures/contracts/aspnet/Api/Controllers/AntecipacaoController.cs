namespace Loja.Api.Controllers;

[ApiController]
public sealed class AntecipacaoController : ControllerBase
{
    public const string Prefixo = "RelatorioAntecipacoes";

    [HttpPost(Prefixo + "/GravarRelatorio")]
    public IActionResult Gravar() => Ok();

    [HttpDelete(Prefixo + "/ExcluirRelatorio")]
    public IActionResult Excluir() => Ok();

    [HttpPost("api/TesteEmail/EnviarConsolidado")]
    public IActionResult Enviar() => Ok();
}

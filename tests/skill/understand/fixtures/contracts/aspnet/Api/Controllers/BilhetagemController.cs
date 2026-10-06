namespace Loja.Api.Controllers;

[ApiController]
[Route("api/excel")]
public sealed class BilhetagemController : ControllerBase
{
    public const string Caminho = "GerarConsolidado/relatorio";
    public const string CaminhoJson = "/api/consolidado/bilhetagem";

    [HttpPost(Caminho)]
    public IActionResult Gerar() => Ok();

    [HttpGet(CaminhoJson)]
    public IActionResult Json() => Ok();
}

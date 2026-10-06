namespace Loja.Portado.Controllers;

[Route("[controller]")]
public class ExportarController : ControllerBase
{
    [HttpGet("/GetContas")]
    public IActionResult Contas() => Ok();

    [HttpPost("Gerar")]
    public IActionResult Gerar() => Ok();
}

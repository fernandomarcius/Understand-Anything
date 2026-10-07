namespace Loja.Api.Controllers;

[Route("[controller]")]
public class ParametrosController : Controller
{
    [HttpGet("/GetParametros")]
    public IActionResult GetParametros() => Ok();

    [HttpGet("Listar")]
    public IActionResult Listar() => Ok();
}

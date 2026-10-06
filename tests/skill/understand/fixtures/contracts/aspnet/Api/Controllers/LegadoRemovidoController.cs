namespace Loja.Api.Controllers;

[ApiController]
public sealed class LegadoRemovidoController : ControllerBase
{
    public const int OrdemDoCatchAll = int.MaxValue;

    [Route("api/motor/{**resto}", Order = OrdemDoCatchAll)]
    public IActionResult Motor() => StatusCode(410);
}

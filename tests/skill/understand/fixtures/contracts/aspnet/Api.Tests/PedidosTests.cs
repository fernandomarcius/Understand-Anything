namespace Loja.Api.Tests;
[Route("api/[controller]")]
public class FakeController : ControllerBase
{
    [HttpGet("nao-conta")]
    public IActionResult X() => Ok();
}

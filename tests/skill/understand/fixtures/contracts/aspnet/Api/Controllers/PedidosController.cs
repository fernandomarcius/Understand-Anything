using Microsoft.AspNetCore.Mvc;

namespace Loja.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class PedidosController : ControllerBase
    {
        // [HttpGet("comentado")] must not count
        [HttpGet("elegiveis")]
        public IActionResult Elegiveis([FromQuery] string? competencia) => Ok();

        [HttpGet]
        public IActionResult Listar() => Ok();

        [HttpPost("{id:int}/aprovar")]
        [Authorize]
        public IActionResult Aprovar(int id) => Ok();

        [HttpGet("[action]")]
        public async Task<IActionResult> ResumoAsync() => Ok();
    }
}

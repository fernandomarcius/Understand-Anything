namespace Loja.Api.Controllers;

// The class name differs from the file name: [controller] comes from the class.
[ApiController]
[Route("/api/[controller]")]
public class EstruturadorMailsController : ControllerBase
{
    [HttpGet("getall")]
    public IActionResult GetAll() => Ok();
}

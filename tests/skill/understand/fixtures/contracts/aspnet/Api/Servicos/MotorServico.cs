namespace Loja.Api.Servicos;

public class MotorServico
{
    private static HttpClient _sharedClient;
    private readonly IRepositorio _repositorio;

    public async Task<byte[]> ExplosaoAsync(string obraId)
    {
        await _repositorio.GetAsync(obraId);

        _sharedClient = new()
        {
            BaseAddress = new Uri(Environment.GetEnvironmentVariable("URL_API_MOTOR")),
            Timeout = TimeSpan.FromMinutes(10),
        };
        var response = await _sharedClient.GetAsync($"referencia_1/explosao/gerar_excel?obraid={obraId}");
        return await response.Content.ReadAsByteArrayAsync();
    }

    public async Task<string> ExternoAsync()
    {
        using var client = new HttpClient();
        var r = await client.GetStringAsync("https://viacep.example.com/ws/01001000/json");
        return r;
    }
}

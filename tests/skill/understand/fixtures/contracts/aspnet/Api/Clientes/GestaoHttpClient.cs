namespace Loja.Api.Clientes;

public sealed class GestaoHttpClient : IGestaoClient
{
    private readonly HttpClient _httpClient;

    public GestaoHttpClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<string> ElegiveisAsync(string competencia, CancellationToken ct)
    {
        var qs = new List<string> { $"competencia={competencia}" };
        var url = $"api/Pedidos/elegiveis?{string.Join("&", qs)}";

        var response = await _httpClient.GetAsync(url, ct);
        return await response.Content.ReadAsStringAsync(ct);
    }
}

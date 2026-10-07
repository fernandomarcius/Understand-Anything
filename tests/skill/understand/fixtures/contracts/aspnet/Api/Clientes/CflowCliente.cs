namespace Loja.Api.Clientes;

public sealed class CflowCliente(HttpClient http) : ICflowCliente
{
    public async Task<string> ExecucaoAsync(string id, CancellationToken ct)
    {
        using var resp = await http.SendAsync(Get($"execucoes/{Uri.EscapeDataString(id)}"), ct);
        return await resp.Content.ReadAsStringAsync(ct);
    }

    public async Task ExecutarAsync(string pipelineId, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"pipelines/{pipelineId}/executar");
        using var resp = await http.SendAsync(req, ct);
    }

    public Task<HttpResponseMessage> TarefaAsync(CancellationToken ct) =>
        EnviarAsync(HttpMethod.Put, "v1/tarefas", ct);

    private async Task<HttpResponseMessage> EnviarAsync(HttpMethod metodo, string caminho, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(metodo, caminho);
        return await http.SendAsync(req, ct);
    }

    private static HttpRequestMessage Get(string caminho) => new(HttpMethod.Get, caminho);
}

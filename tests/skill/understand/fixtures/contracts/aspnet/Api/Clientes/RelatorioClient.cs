namespace Loja.Api.Clientes;

public class RelatorioClient(HttpClient client)
{
    public Task<HttpResponseMessage> Gerar(object corpo) => client.PostAsJsonAsync("relatorios/gerar", corpo);
}

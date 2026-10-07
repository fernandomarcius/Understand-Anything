namespace Loja.Api.Servicos;

public class DataFetcher
{
    private readonly string _apiDuckDb = Variaveis.ApiDuckDB;

    public async Task<string> ConsultarAsync(string tabela)
    {
        var consulta = $"SELECT * FROM {tabela};";
        return await PostHttpResponseAsync($"{_apiDuckDb}/query", consulta);
    }

    private async Task<string> PostHttpResponseAsync(string url, string sql)
    {
        using var client = new HttpClient();
        var response = await client.PostAsync(url, new StringContent(sql));
        return await response.Content.ReadAsStringAsync();
    }
}

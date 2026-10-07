namespace Loja.Api.Servicos;

public static class Variaveis
{
    public static string ApiDuckDB => Environment.GetEnvironmentVariable("API_DUCKDB") ??
                                       throw new ArgumentNullException("API_DUCKDB");
}

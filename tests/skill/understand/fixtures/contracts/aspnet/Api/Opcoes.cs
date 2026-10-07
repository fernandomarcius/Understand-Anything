namespace Loja.Api;

public sealed class Opcoes
{
    public string? CflowApi { get; set; }
    public string CodeqCommandExecutar { get; set; } = "cflow.executar";

    public static Uri? BaseComBarra(string? url) => url is null ? null : new Uri(url.TrimEnd('/') + "/");

    public static Opcoes DoAmbiente(Func<string, string?>? ler = null)
    {
        ler ??= Environment.GetEnvironmentVariable;
        return new Opcoes
        {
            CflowApi = ler("CFLOW_API"),
        };
    }
}

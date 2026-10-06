using Loja.Api.Clientes;

var builder = WebApplication.CreateBuilder(args);

var gestaoUrl = Environment.GetEnvironmentVariable("APP_API_GESTAO")
    ?? throw new InvalidOperationException("APP_API_GESTAO not configured");

builder.Services.AddHttpClient<IGestaoClient, GestaoHttpClient>(client =>
{
    client.BaseAddress = new Uri(gestaoUrl);
});
builder.Services.AddHttpClient<ICflowCliente, CflowCliente>((sp, c) =>
{
    var o = sp.GetRequiredService<Opcoes>();
    if (Opcoes.BaseComBarra(o.CflowApi) is { } b) c.BaseAddress = b;
});
builder.Services.AddHttpClient<RelatorioClient>(c => c.BaseAddress = new Uri(builder.Configuration["Servicos:Relatorio"]!));
builder.Services.Configure<MvcOptions>(o => o.Conventions.Add(new PortadoNativo.RotasDoPortado()));

var app = builder.Build();
app.MapControllers();
app.MapHealthChecks("/healthz");
app.MapGet("/ping", () => "pong");
var v1 = app.MapGroup("/v1");
v1.MapPost("/eventos/{id}", (int id) => Results.Ok());
app.Run();

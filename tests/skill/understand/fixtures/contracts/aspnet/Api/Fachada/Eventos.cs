namespace Loja.Api.Fachada;

public sealed class Eventos(IProducer<string, string> producer, IModel channel)
{
    public Task Publicar() => producer.ProduceAsync("pedidos-criados", new Message<string, string>());
    public void Fila() => channel.BasicPublish(exchange: "", routingKey: "fila-cargas", body: null);
}

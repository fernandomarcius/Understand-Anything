using Shop.Core.Domain;
using static Shop.Core.Math.Calc;
using ClockAlias = Shop.Core.Infra.Clock;

namespace Shop.Api.Controllers;

// IUnusedPolicy is only mentioned in this comment.
public class OrdersController
{
    private readonly AppSettings _settings;
    private readonly GeneratedMarker _marker;

    public OrdersController(AppSettings settings) => _settings = settings;

    public Order Get()
    {
        var clock = new ClockAlias();
        // Guard lives behind Shop.Core's global using, which does not reach Shop.Api.
        Guard.NotNull(clock);
        return new Order();
    }

    public decimal Rounded(decimal value) => Round(value);

    public string Describe(Order order) => $"Order {order} in {nameof(Currency)}";
}

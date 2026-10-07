namespace Shop.Core.Domain;

// File-scoped namespace. Money lives in the same namespace (no using needed);
// Guard comes from the project-wide `global using Shop.Core.Common;`.
public class Order
{
    public Money Total { get; } = new Money(0m);

    public void Validate()
    {
        Guard.NotNull(this);
        var label = "IUnusedPolicy is only mentioned inside a string";
    }
}

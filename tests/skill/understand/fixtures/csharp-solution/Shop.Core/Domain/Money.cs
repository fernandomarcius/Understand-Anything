namespace Shop.Core.Domain
{
    public record Money(decimal Amount);

    public enum Currency
    {
        Brl,
        Usd,
    }
}

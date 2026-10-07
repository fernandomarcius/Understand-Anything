namespace Shop.Core.Common;

public static class Guard
{
    public static void NotNull(object? value)
    {
        if (value is null) throw new ArgumentNullException(nameof(value));
    }
}

namespace Shop
{
    namespace Core.Infra
    {
        public sealed class Clock
        {
            public DateTime Now() => DateTime.UtcNow;
        }

        public delegate void Tick(Clock source);
    }
}

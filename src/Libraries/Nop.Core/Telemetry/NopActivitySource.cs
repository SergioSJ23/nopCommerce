using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Core.Telemetry;

/// <summary>
/// Central ActivitySource and Meter for nopCommerce OTel instrumentation.
/// Uses System.Diagnostics — no OTel NuGet dependency required in Nop.Core.
/// </summary>
public static class NopActivitySource
{
    public const string ActivitySourceName = "Nop.Checkout";

    public static readonly ActivitySource ActivitySource = new(ActivitySourceName, "1.0.0");

    public static readonly Meter Meter = new(ActivitySourceName, "1.0.0");
}

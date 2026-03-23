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

    public static readonly Histogram<double> DbWriteDuration =
        Meter.CreateHistogram<double>("checkout.db_write_duration",
            description: "Duration of SaveOrderDetailsAsync in ms — DB degradation is visible here before HTTP timeouts reach users");

    public static readonly Counter<long> PaymentErrors =
        Meter.CreateCounter<long>("checkout.provider_outcome",
            description: "Payment provider outcomes tagged by result — partial provider degradation shows as rising failure rate before 100% outage");

    public static readonly Histogram<double> CartAgeSeconds =
        Meter.CreateHistogram<double>("checkout.cart_age_seconds",
            description: "Age of cart at checkout time in seconds — values below 5s indicate bot activity or automation");
}

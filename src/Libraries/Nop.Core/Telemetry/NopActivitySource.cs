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
        Meter.CreateHistogram<double>("checkout.db_write_duration", unit: "ms",
            description: "Duration of SaveOrderDetailsAsync — DB degradation is visible here before HTTP timeouts reach users");

    public static readonly Counter<long> PaymentErrors =
        Meter.CreateCounter<long>("checkout.payment_errors",
            description: "Payment attempt outcomes tagged by result — partial provider degradation shows as rising failure rate before 100% outage");

    public static readonly Histogram<double> CartAgeSeconds =
        Meter.CreateHistogram<double>("checkout.cart_age_seconds", unit: "s",
            description: "Age of cart at checkout time — values below 5s indicate bot activity or automation");
}

using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nop.Core.Infrastructure;
using Nop.Core.Telemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using OpenTelemetry.Exporter;

namespace Nop.Web.Framework.Infrastructure;

/// <summary>
/// Registers OTel tracing for the order placement flow.
/// Auto-discovered by NopEngine via INopStartup — no changes to Program.cs needed.
/// </summary>
public class OTelStartup : INopStartup
{
    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        var otlpEndpoint = configuration.GetValue<string>("OTel:OtlpEndpoint") ?? "http://localhost:4317";

        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(
                serviceName: "nopCommerce",
                serviceVersion: "5.0"))
            .WithTracing(tracing => tracing
                .AddAspNetCoreInstrumentation(options =>
                {
                    // exclude static assets — they add noise without operational value
                    options.Filter = ctx =>
                        !ctx.Request.Path.StartsWithSegments("/lib") &&
                        !ctx.Request.Path.StartsWithSegments("/images") &&
                        !ctx.Request.Path.StartsWithSegments("/css") &&
                        !ctx.Request.Path.StartsWithSegments("/js");

                    // replace generic route template names with the actual request path
                    options.EnrichWithHttpRequest = (activity, request) =>
                    {
                        if (activity.DisplayName.Contains("{controller="))
                            activity.DisplayName = $"{request.Method} {request.Path}";
                    };
                })
                .AddSource(NopActivitySource.ActivitySourceName)
                .AddOtlpExporter(options => options.Endpoint = new Uri(otlpEndpoint)))
            .WithMetrics(metrics => metrics
                .AddMeter(NopActivitySource.ActivitySourceName)
                .AddAspNetCoreInstrumentation()
                .AddView(
                    instrumentName: "checkout.cart_age_seconds",
                    metricStreamConfiguration: new ExplicitBucketHistogramConfiguration
                    {
                        Boundaries = new double[] { 1, 2, 5, 10, 15, 20, 30, 45, 60, 120, 300 }
                    })
                .AddOtlpExporter(options =>
                {
                    options.Endpoint = new Uri(otlpEndpoint);
                    options.Protocol = OtlpExportProtocol.Grpc;
                }));
    }

    public void Configure(IApplicationBuilder application)
    {
        // metrics are pushed via OTLP — no scraping endpoint needed
    }

    /// <summary>
    /// Run after NopStartup (2000) so all services are already registered
    /// </summary>
    public int Order => 2100;
}

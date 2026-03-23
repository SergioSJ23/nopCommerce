# Critique — Observability in nopCommerce

## What helped and what hindered

nopCommerce's layered, interface-driven design made the registration side of instrumentation smooth. The `INopStartup` extension point allowed the entire OTel SDK setup — exporters, resource configuration, ASP.NET Core auto-instrumentation — to be added in a single new file (`OTelStartup.cs`) without touching a single existing class. That is the system working as intended: infrastructure concerns slot in at the framework layer without polluting business logic.

The decision to place `NopActivitySource` in `Nop.Core` using only `System.Diagnostics.ActivitySource` and `System.Diagnostics.Metrics` — both part of the BCL — meant the domain library gained a telemetry anchor with no new NuGet dependency. The OTel SDK only appears in `Nop.Web.Framework`, which already owns all infrastructure wiring. That is a clean architectural boundary respected.

The main structural obstacle was `IEventPublisher`. On paper it is a single chokepoint through which every domain event flows — an ideal instrumentation boundary. In practice, its implementation resolves consumers via `EngineContext.Current.ResolveAll<IConsumer<TEvent>>()`, a static service locator call made from inside `PublishAsync`. This means the publisher cannot be wrapped with a decorator that injects or propagates trace context: a decorator would be called, but the actual dispatch bypasses it entirely. Observing the event system requires modifying the publisher itself or adding instrumentation inside each consumer — neither is surgical.

The second obstacle was `OrderProcessingService`. It is the highest-value target in the codebase — cart age, payment outcome, and DB write duration are only meaningful when measured from inside it — but at around 1600 lines and 40 injected dependencies it is also the riskiest file to touch. Every metric recording added there is a change deep inside business logic, not at a boundary.

## The surgical changes and why they were necessary

Four files in existing code required direct modification.

`Nop.Web.Framework.csproj` received the OTel NuGet package references (`OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Instrumentation.AspNetCore`, `OpenTelemetry.Exporter.OpenTelemetryProtocol`). Confining all OTel SDK dependencies to this single project file was a deliberate choice: it keeps the domain and service layers free of telemetry packages, which preserves testability and avoids coupling business logic to an observability vendor.

`CheckoutController.cs` received spans around `PlaceOrderAsync` and `PostProcessPaymentAsync`. The controller is the outermost layer before the service call — opening the span there gives the widest possible coverage of the operation and means the activity is live when `PlaceOrderAsync` runs, so any child spans created inside it are correctly parented. The change adds fifteen lines and touches no logic.

`OrderProcessingService.cs` required two distinct additions. First, three metric recordings inside the local function `placeOrder` within `PlaceOrderAsync`: cart age at the moment the order is submitted, payment outcome tagged as success or timeout, and a stopwatch around `SaveOrderDetailsAsync` for DB write duration. These could not be placed anywhere else — cart age requires access to the shopping cart items, payment outcome is only known after `GetProcessPaymentResultAsync` returns, and DB write duration wraps a private method not exposed through any interface. Second, a payment failure simulation controlled by the `PAYMENT_FAILURE_RATE` environment variable. This addition was necessary for observability reasons: the Manual Payment plugin used in the development environment always succeeds, which means the `checkout.provider_outcome` metric would only ever record successes. A dashboard panel showing a flat success line conveys nothing operationally useful. The simulation injects realistic gateway timeout failures at a configurable rate, making the error rate panel meaningful and allowing the dashboard to demonstrate what degradation looks like before it becomes a full outage. The variable defaults to zero, so there is no effect unless explicitly set — production behaviour is unchanged.

`docker-compose.yml` was extended to add the full observability stack: OTel Collector, Prometheus, Tempo, and Grafana, wired together so that traces flow Collector → Tempo and metrics flow Collector → Prometheus → Grafana. This is infrastructure configuration, not application code, but it represents the delivery boundary of the instrumentation — without it, the spans and metrics emitted by the application have nowhere to go.

## Metric justification

Three custom metrics were added.

`checkout.cart_age_seconds` measures how long a cart existed before the order was submitted. It was chosen because cart age is a direct signal of user behaviour at the moment of purchase. A spike in very low values indicates automated traffic — bots adding to cart and checking out immediately without any browsing. To mitigate this, a developer could add a CAPTCHA to the confirm order step to block automated submissions.

`checkout.db_write_duration` measures the time spent inside `SaveOrderDetailsAsync`, the method that persists the placed order to SQL Server. It was chosen because it isolates the persistence layer from the rest of the checkout pipeline. A rising P95 or P99 points specifically to database degradation — slow disk, lock contention, or an overloaded server — before that degradation is visible in end-to-end response times. An operator seeing this metric climb should investigate the SQL Server instance and check for blocking queries before users start experiencing timeouts.

`checkout.provider_outcome` measures payment processing attempts, tagged with `result=success` or `result=timeout`. It was chosen because it isolates payment provider failures from all other failure modes in the checkout flow. A rising timeout rate points directly to the payment plugin or an upstream provider dependency and tells the operator to check provider status pages or switch to a fallback payment method — rather than investigating application code or infrastructure.

## What I would change going forward, and at what cost

The single most valuable structural change would be replacing the service locator in `EventPublisher` with constructor injection of `IEnumerable<IConsumer<TEvent>>`. This would unlock decorator-based instrumentation of every domain event — one wrapper class giving full observability across the entire event system. The cost is real: it touches `NopEngine`, the consumer registration scan, and the publisher itself. It is not a refactor to do lightly, but it is the correct long-term investment because the event system is where the most operationally relevant state transitions happen.

The second change would be bridging nopCommerce's custom `ILogger` (which writes to a database table) to `Microsoft.Extensions.Logging`. Without this bridge, application-level logs are invisible to the OTel pipeline. Log-trace correlation — the ability to jump from a Grafana trace to the log lines emitted during that request — is impossible in the current setup. This bridge is more invasive than the first change but is the right investment for a production observability story. A practical middle ground is to implement the bridge first, then migrate call sites incrementally.

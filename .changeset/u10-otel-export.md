---
"@runfusion/fusion": minor
---

Export Command Center analytics over OpenTelemetry (OTLP) so teams can ship token / cost / activity metrics to Datadog / Grafana / etc. **Disabled by default** (U10, R4).

- New pure mapping `mapAnalyticsToOtlp` in `@fusion/core` (`otel-metrics.ts`) turns the token/cost/activity aggregator outputs into the OTLP/HTTP JSON wire shape (`resourceMetrics`) — counters for token/cost, gauges for activity — with `model` / `provider` / `node.id` / `agent.id` attributes per data point. Fully testable without a live collector; no SDK dependency in core.
- Dashboard exporter (`otel-exporter.ts`) periodically maps current analytics and POSTs them to a configured collector, wired into `server.ts` startup/shutdown.

**SDK choice:** ships a **minimal OTLP/HTTP JSON exporter rather than the official `@opentelemetry/*` SDK** — and therefore adds **no new runtime dependency**. The OTLP/HTTP JSON protocol is a single, stable `POST /v1/metrics` of a well-defined JSON envelope (built in core), so for a default-disabled feature we avoid pulling the multi-package SDK (sdk-metrics + exporter-metrics-otlp-http + resources + api). The wire shape is collector-compatible; swapping in the official SDK later is mechanical. (If maintainers prefer the real SDK, that is a follow-up changeset + dependency add.)

**Enabled only via env** (none set ⇒ nothing starts): `FUSION_OTEL_METRICS_ENDPOINT` (full `/v1/metrics` URL, required to enable), `FUSION_OTEL_METRICS_HEADERS` (`k=v,k2=v2` auth headers), `FUSION_OTEL_METRICS_INTERVAL_MS`, `FUSION_OTEL_METRICS_TIMEOUT_MS`, `FUSION_OTEL_RESOURCE_ATTRIBUTES`.

**Security:** endpoint validated on write — `http://` is rejected in production (exporter does not start) and warns loudly otherwise; auth header (Datadog/Grafana token) VALUES are never logged and are masked in diagnostics; a collector-unreachable failure logs (redacted) and backs off exponentially without crashing the server or blocking requests.

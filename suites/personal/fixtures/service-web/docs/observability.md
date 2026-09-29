# Observability

All of these are reachable from the corp network and the ops laptops.

| What | Where |
| --- | --- |
| SLO status | `http://slo.internal.quillmart.com/api/v1/slos` |
| Prometheus | `http://prometheus.internal.quillmart.com` (HTTP API: `/api/v1/query`, `/api/v1/query_range`) |
| Traces (Jaeger) | `http://tracing.internal.quillmart.com` (API: `/api/services`, `/api/traces?service=...`, `/api/traces/<id>`, `/api/dependencies`) |
| Flags | `http://flags.internal.quillmart.com/api/v1/flags` (needs `Authorization: Bearer $(gcloud auth print-identity-token)`) |
| Grafana | `https://grafana.internal.quillmart.com` (SSO; browser only) |
| Logs | `kubectl logs`, or `gcloud logging read` |

## Metrics you will want

- `http_server_request_duration_seconds_bucket{service=...}` (every service, OpenTelemetry)
- `http_server_requests_total{service=..., code=...}`
- `istio_requests_total{source_workload, destination_workload, response_code, response_flags}`
- `istio_request_duration_milliseconds_bucket{source_workload, destination_workload}`
- `envoy_cluster_upstream_rq_retry{source_workload, cluster_name}` (retries the sidecar made)
- `pricing_cache_hit_ratio`, `pricing_cache_ttl_seconds`
- `promo_engine_inflight_requests`, `promo_engine_shed_total`

Examples:

```
curl -s 'http://prometheus.internal.quillmart.com/api/v1/query' \
  --data-urlencode 'query=histogram_quantile(0.99, sum by (le, service) (rate(http_server_request_duration_seconds_bucket[5m])))'

curl -s 'http://tracing.internal.quillmart.com/api/traces?service=checkout-api&minDuration=1s&limit=5'
```

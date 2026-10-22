# Load testing

Three scenarios per PRD §11. Run against a locally running `docker compose up` stack.

## Setup

Before running either k6 script, create the test endpoint:

```bash
curl -X POST http://localhost:3000/api/endpoints \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"k6 Load Test","slug":"k6-load-test","provider":"generic_hmac","verification":{"secret_ref":"WEBHOOK_SECRET_K6_LOAD_TEST"},"destinations":[]}'
```

The app/worker containers need `WEBHOOK_SECRET_K6_LOAD_TEST=k6-load-secret` set (already added to `docker-compose.yml`).

## Scenario 1 — sustained ingest

```bash
docker run --rm --network webhook-inspector_default \
  -v "$(pwd)/k6:/scripts" grafana/k6 run \
  -e BASE_URL=http://app:3000 /scripts/sustained-ingest.js
```

Ramps RPS in steps until p99 ingest latency exceeds 500ms. Published numbers go below.

## Scenario 2 — burst

```bash
docker run --rm --network webhook-inspector_default \
  -v "$(pwd)/k6:/scripts" grafana/k6 run \
  -e BASE_URL=http://app:3000 /scripts/burst.js
```

2,000 deliveries in ~10s.

## Scenario 3 — delivery throughput

Not a k6 script — delivery throughput is bounded by the worker's concurrency and the destination's latency, not ingest rate. Measured by: standing up a mock destination with a fixed 200ms response time, ingesting a large batch against an endpoint pointed at it, then polling `GET /api/deliveries/stats` for the `delivered` count over time to compute sustained drain rate.

## Results

See `RESULTS.md` for published numbers, the bottleneck identified at each stage, and what would be changed first.

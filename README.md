# Webhook Delivery Inspector

Self-hostable service that receives webhooks from any provider, verifies
them, stores every delivery with its full request and attempt history,
forwards to configured destinations with retries, and exposes a queryable
API for debugging failed integrations.

See [`PRD.md`](./PRD.md) for the full design doc, rationale, and milestones.

## Status: M1 + M2 + M3 complete

What exists right now:

- TypeScript (`strict: true`), Fastify, MongoDB official driver (no Mongoose)
- `endpoints` and `deliveries` collections with the full index set from the PRD
- `POST /ingest/:slug` — raw-body capture, per-scheme signature verification
  (Stripe, GitHub, generic HMAC), idempotent insert via a unique index
- `GET/POST/PATCH /api/endpoints`, `GET /api/deliveries` (cursor-paginated,
  filterable), `GET /api/deliveries/:id`, `POST /api/deliveries/:id/replay`,
  `GET /api/deliveries/stats` (aggregation pipeline)
- `/healthz`, `/readyz` (Mongo + Redis)
- BullMQ queue + worker: atomic claim (`findOneAndUpdate` with `status:
  'queued'` in the filter), real HTTP delivery to configured destinations,
  retry classification + jittered exponential backoff, a retry scanner that
  re-enqueues deliveries once `next_retry_at` passes, a stale-claim sweep
  that reclaims deliveries stuck in `delivering` after a dead worker
- `/metrics` on both `app` (ingest counters/histogram) and `worker` (its own
  endpoint, port 3001 — a separate process means a separate registry;
  delivery attempts, delivery duration, queue depth, dead-letter count,
  Mongo operation duration), all confirmed emitting under real traffic, not
  just defined
- OpenTelemetry tracing: a full ingest-through-delivery trace is one linked
  trace in Jaeger (`webhook.ingest` → `verify_signature`/`persist`/`enqueue`,
  and `webhook.deliver` → `mongo.claim`/`http.request`/`mongo.record_attempt`),
  with trace context propagated across the Redis queue boundary so the two
  halves aren't disconnected traces; `trace_id` persisted on the delivery
  document for API→trace lookup
- Prometheus scraping both services; Grafana dashboard (ingest rate, delivery
  success rate by endpoint, p50/p95/p99 delivery latency, queue depth,
  dead-letter rate, Mongo op duration)
- Docker Compose stack (`app` + `worker` + `mongo` + `redis` + `jaeger` +
  `prometheus` + `grafana`), verified booting end-to-end and delivering a
  real webhook through to a live destination, including the full
  retry → dead → replay → delivered path
- Vitest unit suite: signature verification (incl. timing-safe comparison
  and replay-window rejection), idempotency key derivation, retry
  classification (table-driven), backoff/jitter bounds — 35 tests passing

Not yet built (see PRD milestone M4): the MCP server and k6 load tests (the
latter is actually already done — see `k6/RESULTS.md` — M4 just hasn't had
the MCP server built yet).

## Running it

```bash
docker compose up --build
```

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
curl http://localhost:3000/metrics      # app metrics
curl http://localhost:3001/metrics      # worker metrics

curl -X POST http://localhost:3000/api/endpoints \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Endpoint","slug":"my-endpoint","provider":"generic_hmac"}'
```

- Jaeger UI: http://localhost:16686
- Prometheus UI: http://localhost:9090
- Grafana: http://localhost:3002 (anonymous admin access, local dev only)

For local dev without Docker: `npm install`, copy `.env.example` to `.env`,
run a local MongoDB on `27017`, then `npm run dev`.

## Tests

```bash
npm run typecheck
npm test
```

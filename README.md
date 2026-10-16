# Webhook Delivery Inspector

Self-hostable service that receives webhooks from any provider, verifies
them, stores every delivery with its full request and attempt history,
forwards to configured destinations with retries, and exposes a queryable
API for debugging failed integrations.

See [`PRD.md`](./PRD.md) for the full design doc, rationale, and milestones.

## Status: M1 + M2 complete

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
- Docker Compose stack (`app` + `worker` + `mongo` + `redis`), verified
  booting end-to-end and delivering a real webhook through to a live
  destination, including the full retry → dead → replay → delivered path
- Vitest unit suite: signature verification (incl. timing-safe comparison
  and replay-window rejection), idempotency key derivation, retry
  classification (table-driven), backoff/jitter bounds — 35 tests passing

Not yet built (see PRD milestones M3–M4): OTel tracing, Prometheus
`/metrics`, Grafana dashboard, the MCP server, and k6 load tests.

## Running it

```bash
docker compose up --build
```

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz

curl -X POST http://localhost:3000/api/endpoints \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Endpoint","slug":"my-endpoint","provider":"generic_hmac"}'
```

For local dev without Docker: `npm install`, copy `.env.example` to `.env`,
run a local MongoDB on `27017`, then `npm run dev`.

## Tests

```bash
npm run typecheck
npm test
```

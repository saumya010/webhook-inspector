# Webhook Delivery Inspector

Self-hostable service that receives webhooks from any provider, verifies
them, stores every delivery with its full request and attempt history,
forwards to configured destinations with retries, and exposes a queryable
API for debugging failed integrations.

See [`PRD.md`](./PRD.md) for the full design doc, rationale, and milestones.

## Status: M1 (core) complete

What exists right now:

- TypeScript (`strict: true`), Fastify, MongoDB official driver (no Mongoose)
- `endpoints` and `deliveries` collections with the full index set from the PRD
- `POST /ingest/:slug` — raw-body capture, per-scheme signature verification
  (Stripe, GitHub, generic HMAC), idempotent insert via a unique index
- `GET/POST/PATCH /api/endpoints`, `GET /api/deliveries` (cursor-paginated,
  filterable), `GET /api/deliveries/:id`, `POST /api/deliveries/:id/replay`,
  `GET /api/deliveries/stats` (aggregation pipeline)
- `/healthz`, `/readyz`
- Docker Compose stack (`app` + `mongo`), verified booting end-to-end
- Vitest unit suite: signature verification (incl. timing-safe comparison
  and replay-window rejection), idempotency key derivation, retry
  classification (table-driven), backoff/jitter bounds — 35 tests passing

Not yet built (see PRD milestones M2–M4): the BullMQ queue/worker, actual
delivery attempts to destinations, stale-claim sweep, OTel/Prometheus/
Grafana, the MCP server, and k6 load tests.

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

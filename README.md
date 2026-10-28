# Webhook Delivery Inspector

A self-hostable service for receiving, verifying, and reliably delivering
webhooks — with full observability and an agent-facing debugging surface.

Point any provider at it. It verifies the signature, stores the full
request and delivery history, forwards it to your destination with retries
and backoff, and gives you an API (and an MCP server) to find out exactly
what happened to any given delivery.

**Read the [write-up](./WRITEUP.md)** for the design decisions and the
measurements behind them — the unique-index idempotency guard, the atomic
claim, why the attempts array is capped at 20, the ESR index ordering, and
the load test results. **Read the [PRD](./PRD.md)** for the original design
spec and what was deliberately left out.

## Why

Webhook integrations fail in ways that are hard to debug after the fact:
a delivery silently retries into a dead end, a destination rate-limits you
and you retry too fast anyway, two workers race on the same delivery, an
outage kills a few hundred deliveries and replaying them one at a time is
tedious. This project exists to make all of that inspectable and correct —
not just "receive a POST and call a URL."

## What it does

- **Verifies signatures** for Stripe, GitHub, and a generic HMAC scheme —
  timing-safe comparison, replay-window rejection.
- **Never loses or duplicates a delivery.** Idempotency is enforced by a
  MongoDB unique index, not an application-level check — concurrent
  identical webhooks can't create duplicate records.
- **Delivers reliably.** A BullMQ-backed worker claims deliveries
  atomically, retries transient failures with jittered exponential
  backoff (honoring a destination's `Retry-After` header when it sends
  one), and gives up cleanly on permanent failures.
- **Recovers from outages.** Dead deliveries can be replayed individually
  or in bulk, scoped by endpoint and time range.
- **Isolates noisy destinations.** One slow or hung destination can't
  starve delivery to every other endpoint.
- **Is fully observable.** Prometheus metrics, and a single Jaeger trace
  spanning a delivery from ingest through its final attempt.
- **Is debuggable by an agent, not just a human.** An MCP server exposes
  the same lookups (and a guarded replay action) as tools.

## Quick start

```bash
git clone https://github.com/saumya010/webhook-inspector.git
cd webhook-inspector
docker compose up --build
```

That starts the API, the delivery worker, MongoDB, Redis, Jaeger,
Prometheus, and Grafana.

```bash
# health checks
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz

# register an endpoint to receive webhooks at
curl -X POST http://localhost:3000/api/endpoints \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "slug": "my-app",
    "provider": "generic_hmac",
    "verification": { "secret_ref": "WEBHOOK_SECRET_MY_APP" },
    "destinations": [{ "url": "https://example.com/webhooks", "enabled": true }]
  }'

# point your provider at:
#   POST http://localhost:3000/ingest/my-app
```

Something sending it will now show up at `GET /api/deliveries`, with its
full attempt history at `GET /api/deliveries/:id`.

| Dashboard | URL |
|---|---|
| Jaeger (traces) | http://localhost:16686 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3002 |

Local dev without Docker: `npm install`, copy `.env.example` to `.env`, run
MongoDB on `27017`, then `npm run dev` (and `npm run worker:dev` for the
delivery worker in a second terminal).

## API

| | |
|---|---|
| `POST /ingest/:slug` | Where providers send webhooks. Public — the signature is the credential. |
| `GET/POST/PATCH /api/endpoints` | Manage endpoints |
| `GET /api/deliveries` | List/filter deliveries (cursor-paginated) |
| `GET /api/deliveries/:id` | Full detail, including attempt history |
| `POST /api/deliveries/:id/replay` | Re-queue one delivery |
| `POST /api/deliveries/replay-bulk` | Re-queue many dead deliveries at once, scoped by endpoint/time range |
| `GET /api/deliveries/stats` | Aggregated counts by status |
| `GET /metrics` | Prometheus exposition (also on the worker, port `3001`) |

All `/api/*` routes require `Authorization: Bearer <API_KEY>` (set via the
`API_KEY` env var; defaults to `dev-local-key` locally).

## MCP server

For an LLM agent to triage deliveries directly:

```bash
npm run mcp
# or
docker compose run --rm mcp
```

Exposes `list_endpoints`, `find_deliveries`, `get_delivery`,
`delivery_stats`, `replay_delivery`, and `replay_dead_deliveries` as MCP
tools over stdio.

## Testing it

```bash
npm run typecheck
npm test            # 42 Vitest unit tests
```

Load test results (sustained ingest, burst, delivery throughput under a
simulated slow destination) are in [`k6/RESULTS.md`](./k6/RESULTS.md).

## Stack

TypeScript (strict), Fastify, the official MongoDB driver (deliberately not
an ODM), BullMQ/Redis, OpenTelemetry, Prometheus/Grafana, the MCP SDK.
Docker Compose for everything. No Kubernetes, no Kafka, no multi-tenancy —
see the PRD's non-goals for why.

## License

MIT

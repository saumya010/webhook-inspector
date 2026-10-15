# Webhook Delivery Inspector — PRD

**Status:** Draft · **Owner:** Saumya Sharma · **Created:** 2026-10-15

---

## 1. Why this exists

Two goals, and the second one is the real one.

**Product goal.** A self-hostable service that receives webhooks from any provider, verifies them, stores every delivery with its full request and attempt history, forwards to configured destinations with retries, and exposes a queryable API for debugging failed integrations.

**Portfolio goal.** Close the gaps that have cost me interviews. Every requirement below traces to something a JD asked for and my resume couldn't answer:

| Gap                   | Asked for by                     | Closed by                                     |
| --------------------- | -------------------------------- | --------------------------------------------- |
| MongoDB               | PostGrid, SerpApi, Knock         | Primary datastore — heterogeneous payloads    |
| TypeScript            | Nearly every JD                  | Written in strict TS throughout               |
| Vitest                | PostGrid                         | Full test suite                               |
| Observability         | BuildOps, RBC, Purpose, Hookdeck | OTel traces + Prometheus metrics, all emitted |
| MCP server            | Mozilla, PostHog                 | Agent-facing query and replay tools           |
| Redis                 | BuildOps, RBC                    | Queue + claim coordination                    |
| Docker                | BuildOps, RBC, Hookdeck          | Compose stack                                 |
| Scale story           | Everywhere                       | Published load test numbers                   |
| Public code + writing | PostHog, Hookdeck, SerpApi       | Repo + write-up                               |

The project must stand on its own as a useful tool. If it reads as a box-ticking exercise, it fails both goals.

---

## 2. Non-goals

Documented deliberately — reasoning about what _not_ to build is part of the artifact.

- **Kafka.** A Redis-backed queue is sufficient at this scale. README will explain what would force a move to a log: ordering across partitions, replay from offset, multiple independent consumer groups.
- **Kubernetes.** Compose is the right deployment unit for a single-node self-hosted tool.
- **GraphQL.** REST with cursor pagination covers the access patterns.
- **Multi-tenancy.** Single-tenant, self-hosted. Auth is a single API key.
- **A full UI.** The API and the data model are the artifact. A minimal read-only page at most.

---

## 3. Users

- **Primary:** a backend engineer debugging why a provider's webhooks aren't landing correctly.
- **Secondary:** an AI agent triaging the same problem through the MCP interface.

---

## 4. Architecture

```
Provider → POST /ingest/:slug
             ↓
         verify signature (per-scheme)
             ↓
         persist delivery (Mongo, unique idempotency key)
             ↓
         enqueue (Redis/BullMQ) ──→ respond 202
             ↓
         worker claims (atomic findOneAndUpdate)
             ↓
         deliver to destination(s)
             ↓
         classify result → success | retry with backoff | dead
```

Ingest never blocks on delivery. The 202 is returned as soon as the delivery is persisted and enqueued.

---

## 5. Data model

MongoDB 7, **official driver — not Mongoose.** Mongoose abstracts away exactly the things this project exists to learn: index behaviour, `explain()` output, aggregation pipelines.

### 5.1 `endpoints`

```ts
{
  _id: ObjectId,
  name: string,
  slug: string,                    // URL path segment, unique
  provider: 'stripe' | 'github' | 'generic_hmac',
  verification: {
    scheme: string,
    secret_ref: string,            // env var NAME — never the secret itself
    tolerance_s: number            // replay window, default 300
  },
  destinations: [{ url: string, enabled: boolean }],
  retry_policy: {
    max_attempts: number,          // default 5
    backoff_base_ms: number,       // default 1000
    backoff_factor: number,        // default 2
    max_backoff_ms: number         // default 300000
  },
  created_at: Date,
  updated_at: Date
}
```

### 5.2 `deliveries` — the core document

```ts
{
  _id: ObjectId,
  endpoint_id: ObjectId,
  idempotency_key: string,         // UNIQUE — the concurrency primitive

  received_at: Date,

  request: {
    headers: Record<string, string>,   // heterogeneous
    body_raw: string,                  // exact bytes — signature re-verification
    body_parsed: unknown,              // provider-specific shape ← the Mongo case
    size_bytes: number,
    source_ip: string
  },

  verification: {
    status: 'passed' | 'failed' | 'skipped',
    scheme: string,
    failure_reason: string | null,
    verified_at: Date
  },

  status: 'received' | 'queued' | 'delivering' | 'delivered' | 'failed' | 'dead',

  attempts: [{                     // CAPPED at 20 — see 5.4
    n: number,
    started_at: Date,
    finished_at: Date | null,
    destination_url: string,
    response_status: number | null,
    response_time_ms: number | null,
    error: { type: string, message: string } | null,
    classification: 'success' | 'retryable' | 'permanent'
  }],
  attempt_count: number,           // separate counter — survives array capping

  claimed_at: Date | null,         // stale-claim detection
  next_retry_at: Date | null,
  trace_id: string,                // OTel correlation
  expires_at: Date                 // TTL
}
```

### 5.3 Why this is a document, not a row

`request.body_parsed` is the justification for the whole choice. Three providers, three unrelated shapes:

- **Stripe:** `{ id, object: 'event', type, data: { object: {...} } }`
- **GitHub:** `{ action, repository: {...}, sender: {...}, ... }`
- **Generic:** arbitrary

In Postgres this is a `JSONB` column and you lose most of the engine's advantages. In Mongo each payload is stored in its native shape and provider-specific nested fields are directly indexable.

### 5.4 The embedded-array decision

`attempts` is embedded because it's always read with the delivery — one round trip, no join.

**But it's capped at 20.** A pathological retry loop against a flapping destination could otherwise grow the document toward the 16MB BSON limit. Overflow writes to a separate `delivery_attempts` collection, and `attempt_count` is maintained independently so capping never loses the true count.

_This is the interview story. Build it capped from the start and write up why._

### 5.5 Indexes

```js
// deliveries
{ idempotency_key: 1 }                           // UNIQUE — compare-and-set
{ endpoint_id: 1, received_at: -1 }              // list by endpoint, newest first
{ status: 1, next_retry_at: 1 }                  // retry scanner — ESR: E=status, R=next_retry_at
{ endpoint_id: 1, status: 1, received_at: -1 }   // filtered list
{ 'verification.status': 1, received_at: -1 }    // PARTIAL: verification.status = 'failed'
{ trace_id: 1 }                                  // jump from record to trace
{ expires_at: 1 }                                // TTL, expireAfterSeconds: 0
{ 'request.body_parsed.type': 1 }                // SPARSE — provider-specific field

// endpoints
{ slug: 1 }                                      // UNIQUE
```

Two to call out in the write-up:

- `{ status: 1, next_retry_at: 1 }` follows **ESR** — equality field first, range field second. Reversed, the index can't seek efficiently.
- The sparse index on `request.body_parsed.type` indexes a field that only exists on some documents. Clean in Mongo, awkward in a relational schema.

**Deliverable:** `explain("executionStats")` output for the three hot queries, committed to the repo, showing `IXSCAN` and a `totalDocsExamined` / `nReturned` ratio near 1.

---

## 6. API

Auth: `Authorization: Bearer <API_KEY>` on `/api/*`. `/ingest/*` is public by design — the signature is the credential.

### Ingest

```
POST /ingest/:slug
→ 202 { delivery_id, duplicate: false }
→ 200 { delivery_id, duplicate: true }     // idempotent replay
→ 401 { error: 'invalid_signature' | 'timestamp_out_of_window' }
→ 404 { error: 'unknown_endpoint' }
→ 413 { error: 'payload_too_large' }       // 1MB cap
```

Raw body captured before parsing — re-stringifying changes key order and breaks signatures.

### Management

```
GET    /api/endpoints
POST   /api/endpoints
GET    /api/endpoints/:id
PATCH  /api/endpoints/:id

GET    /api/deliveries
       ?endpoint_id= &status= &verification_status=
       &since= &until= &limit= &cursor=
GET    /api/deliveries/:id
POST   /api/deliveries/:id/replay
GET    /api/deliveries/stats?endpoint_id=&window=24h
```

`/stats` is where the aggregation pipeline lives: `$match` → `$group` by status and endpoint → `$sort`. Returns counts, success rate, p50/p95 delivery latency.

### Operational

```
GET /healthz     → 200 always (liveness)
GET /readyz      → 200 | 503 (Mongo + Redis ping)
GET /metrics     → Prometheus exposition
```

---

## 7. Delivery engine

### 7.1 Idempotency

Key derivation is per-provider:

| Provider | Key source                                   |
| -------- | -------------------------------------------- |
| Stripe   | event `id`                                   |
| GitHub   | `X-GitHub-Delivery` header                   |
| Generic  | `sha256(slug + raw_body + timestamp_header)` |

The mechanism: `insertOne` against the unique index. On `E11000` duplicate key, it's a redelivery — return the original `delivery_id` with `duplicate: true`. **No check-then-act anywhere.** The database arbitrates.

### 7.2 Claiming

```js
findOneAndUpdate(
  { _id, status: "queued" },
  { $set: { status: "delivering", claimed_at: new Date() } },
);
```

Atomic. Returns null if another worker won.

**Stale claims:** a delivery in `delivering` with `claimed_at` older than 5 minutes is assumed to belong to a dead worker and is reclaimed. A background sweep every 60s resets them to `queued`. Without this, one crash strands a delivery permanently.

### 7.3 Retry classification

| Result                 | Classification     |
| ---------------------- | ------------------ |
| 2xx                    | success            |
| 408, 429, 5xx          | retryable          |
| Network error, timeout | retryable          |
| Other 4xx              | permanent → `dead` |

Backoff: `min(base × factor^(n-1), max)` **plus jitter** — up to ±20%, so simultaneous failures don't synchronise into a thundering herd.

After `max_attempts`, status → `dead` with the final error recorded. Dead deliveries remain queryable and replayable.

---

## 8. Observability

**Every metric defined below must actually be emitted.** Defining helpers and never calling them is the failure mode to avoid.

### Traces (OpenTelemetry)

```
webhook.ingest                    (root)
├── webhook.verify_signature
├── webhook.persist
└── webhook.enqueue

webhook.deliver                   (root, per attempt)
├── mongo.claim
├── http.request                  → destination
└── mongo.record_attempt
```

`trace_id` is persisted on the delivery document so you can jump from a record in the API to its trace in Jaeger.

### Metrics (Prometheus)

```
webhook_ingest_total{endpoint, verification_status}            counter
webhook_ingest_duration_seconds{endpoint}                      histogram
webhook_delivery_attempts_total{endpoint, classification}      counter
webhook_delivery_duration_seconds{endpoint}                    histogram
webhook_delivery_queue_depth{state}                            gauge
webhook_deliveries_dead_total{endpoint, reason}                counter
mongo_operation_duration_seconds{collection, operation}        histogram
```

Plus `collectDefaultMetrics()` for process and Node runtime.

### Dashboard

Grafana provisioned in Compose: ingest rate, delivery success rate by endpoint, p50/p95/p99 delivery latency, queue depth, dead-letter rate.

---

## 9. MCP server

Exposed over stdio. Tool descriptions matter more than the implementations — the model routes on prose.

| Tool                                                      | Purpose                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `list_endpoints()`                                        | Enumerate configured endpoints                                       |
| `find_deliveries({ endpoint?, status?, since?, limit? })` | Compact summaries — id, status, timestamp, attempt count, last error |
| `get_delivery({ id })`                                    | Full detail including attempt history                                |
| `delivery_stats({ endpoint?, window? })`                  | Aggregated counts and latency                                        |
| `replay_delivery({ id })`                                 | Side-effecting — requires approval                                   |

Design rules:

- Results are compact. They land in a context budget.
- Errors are instructive — say what went wrong and what to try, not just a code.
- Descriptions say _when_ to use the tool, not only what it does.
- Tool results are untrusted input to the model. Payload content is truncated and escaped before being returned.

---

## 10. Testing (Vitest)

**Unit**

- Signature verification per scheme, including timing-safe comparison and replay-window rejection
- Retry classification — table-driven over every status code
- Backoff calculation — jitter bounds, cap behaviour, monotonicity
- Idempotency key derivation per provider

**Integration** (Mongo + Redis via Testcontainers)

- Concurrent duplicate ingest → exactly one delivery created _(the race test)_
- Stale claim reclaim after threshold
- Attempt array capping at the boundary, with `attempt_count` staying correct
- Cursor pagination stability under concurrent writes

**End-to-end**

- Ingest → verify → queue → deliver → `delivered`
- Ingest → destination 500s → retries → `dead`
- Replay of a dead delivery succeeds

Coverage target: **80% on `src/`**, enforced in CI. A test that can't be shown to fail doesn't count as evidence.

---

## 11. Load testing (k6)

| Scenario            | Shape                                                             |
| ------------------- | ----------------------------------------------------------------- |
| Sustained ingest    | Ramp RPS until p99 ingest latency exceeds 500ms                   |
| Burst               | 2,000 deliveries in 10s — the bulk-batch case                     |
| Delivery throughput | Mock destination with 200ms latency, measure sustained drain rate |

Published in the README: throughput, p50/p95/p99, the bottleneck identified, and what I'd change first. This is the scale story the resume currently lacks.

---

## 12. Stack

| Layer    | Choice                             | Note                                                            |
| -------- | ---------------------------------- | --------------------------------------------------------------- |
| Language | TypeScript, `strict: true`         | No `any` in `src/`                                              |
| HTTP     | Fastify                            | Faster than Express, and adds range beyond what's on the resume |
| Database | MongoDB 7, official driver         | Not Mongoose — see §5                                           |
| Queue    | Redis + BullMQ                     | Known quantity, keeps focus on Mongo                            |
| Tracing  | OpenTelemetry SDK + Jaeger         |                                                                 |
| Metrics  | prom-client + Prometheus + Grafana |                                                                 |
| Tests    | Vitest + Testcontainers            |                                                                 |
| Load     | k6                                 |                                                                 |
| CI       | GitHub Actions                     | typecheck, lint, test, coverage gate                            |
| Deploy   | Docker Compose                     | app, mongo, redis, prometheus, grafana, jaeger                  |

---

## 13. Milestones

Shippable at every stop.

**M1 — Core (weekend 1)**
TypeScript scaffold, Mongo connection, `endpoints` and `deliveries` collections with indexes, ingest endpoint, signature verification for all three schemes, delivery list and detail API. No delivery yet — receive and store only.

**M2 — Delivery engine (weekend 2)**
BullMQ queue, worker with atomic claim, retry classification and backoff with jitter, DLQ, replay endpoint, stale-claim sweep, idempotency via unique index. Vitest suite covering §10 unit and integration.

**M3 — Observability (weekend 3)**
OTel instrumentation end to end, Prometheus metrics all wired and verified emitting, Grafana dashboard provisioned, `/healthz` and `/readyz`. Commit `explain()` output for hot queries.

**M4 — Agent surface and proof (weekend 4)**
MCP server with five tools, k6 load tests, README, and the write-up.

---

## 14. Success criteria

Done means:

1. `docker compose up` produces a working stack with a seeded endpoint
2. A real webhook from Stripe's CLI or a GitHub test delivery flows end to end
3. Coverage gate passes in CI at 80%
4. Every defined metric is observably emitting under load
5. A trace for a single delivery is viewable in Jaeger, spanning ingest through final attempt
6. An agent can find a failed delivery and replay it through MCP, unaided
7. Load numbers are published with a named bottleneck
8. The write-up exists

---

## 15. The write-up

The repo is table stakes. The post is what gets read.

Structure it the way the ReDoS entry was written — the failure is the interesting part:

- Why a document store, with the three payload shapes as evidence
- The embedded-array decision, the 16MB limit, and why `attempt_count` is separate
- Index design and the ESR ordering, with real `explain()` output before and after
- Idempotency as a unique-index compare-and-set, and why check-then-act loses the race
- Where it fell over under load and what I'd fix first
- One thing I got wrong

Three companies currently in the pipeline value public technical writing explicitly — SerpApi asks for it, Hookdeck welcomes it, PostHog says they document everything publicly.

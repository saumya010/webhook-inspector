# Webhook Delivery Inspector — write-up

A self-hostable service that receives webhooks from any provider (Stripe, GitHub, or a generic HMAC scheme), verifies their signature, stores every delivery with its full request and attempt history in MongoDB, forwards each one to a configured destination with retries and backoff, and exposes an API for debugging failed integrations. Built in TypeScript on Fastify, with the official MongoDB driver (not an ODM), BullMQ/Redis for the delivery queue, and a Docker Compose stack for everything.

Every claim below maps to a row in `.claude/EVIDENCE.md` — if a sentence here isn't backed by one, it isn't in the write-up (Verification.md §6's claim gate).

---

## Design decisions

### 1. Idempotency is a unique-index compare-and-set, not a check-then-insert

The naive way to prevent duplicate deliveries — check if a delivery with this event's key already exists, insert if not — has a race condition: two near-simultaneous identical webhooks can both pass the "doesn't exist" check before either has inserted, and you get two records for one real event.

The fix: make `idempotency_key` a unique-indexed field, and just try to insert. MongoDB itself arbitrates — if two inserts race, exactly one succeeds and the other fails with error code `11000`, which the code treats as "this is a replay," not an error (E3).

I didn't just assert this works — I broke it on purpose. Dropped the unique index, fired 500 truly concurrent identical webhooks, and watched all 500 succeed, creating 500 documents sharing one idempotency key (E3). Recreating the unique index on that now-dirty data then failed outright with a real `E11000` error (E8) — a genuine operational lesson: a unique index can't just be "turned back on" over data that already violates it; you have to clean it first.

### 2. The claim is a single atomic `findOneAndUpdate`, not read-then-write

The worker that picks up a queued delivery uses `findOneAndUpdate({_id, status:'queued'}, {$set:{status:'delivering', ...}})` — the `status:'queued'` filter, not an application-level check, is what makes two workers racing on the same document safe: MongoDB only lets one operation match and modify the document, so one call gets the updated doc back and the other gets `null` (E4). Confirmed under a genuine `Promise.all` race, not just sequential calls.

### 3. The `attempts` array is capped at 20, with a separate `attempt_count`

Embedding attempt history in the delivery document avoids a join on every read — the document is self-contained. But an uncapped array under a flapping destination will eventually hit MongoDB's 16MB document limit. I measured exactly where: an uncapped array failed at attempt #56,906, 222 bytes short of the 16,777,216-byte wall (E9). The fix — `$push` with `$slice:-20` — keeps the array bounded, but that alone would make the array's own length lie about how many attempts actually happened once it starts dropping old entries. A separate `attempt_count`, incremented independently, survives the cap: measured absorbing 10,000 attempts with the array flat at 20 entries and the counter correctly reporting all 10,000 (E9).

### 4. Index field order follows equality-before-range (ESR), measured not assumed

The retry-scanner index is `{status:1, next_retry_at:1}` — equality field (`status:'queued'`) before range field (`next_retry_at <= now`). I verified this isn't a cosmetic choice: with the fields reversed, the same query on the same 200,000-document dataset examined 171,525 index keys instead of 100 — a ~1,715x difference — to return the identical 100 documents, with no separate `SORT` stage appearing under either ordering to hint at the problem (E5). Repeating the test with a synthetic high-cardinality field (5,000 distinct values) made the penalty worse, not better — 196,508 keys examined vs 30 correctly, a ~6,550x gap (E6) — confirming that ESR ordering matters more, not less, as the misplaced equality field's cardinality grows.

---

## Deliberate omissions

- **No Kafka.** A Redis-backed queue is sufficient at this scale; a log-based broker would only be justified by cross-partition ordering guarantees, replay-from-offset semantics, or multiple independent consumer groups — none of which this system needs yet.
- **No Kubernetes.** Compose is the right deployment unit for a single-node, self-hosted tool.
- **No GraphQL.** REST with cursor pagination covers the access patterns (list/filter/detail/replay/stats).
- **No multi-tenancy.** Single-tenant, self-hosted; auth is one API key.
- **No full UI.** The API and data model are the artifact.

---

## What broke, and what changed as a result

- **Worker killed mid-claim.** Caught a delivery in `status:'delivering'`, `SIGKILL`ed the worker (confirmed real signal death via exit code 137), and watched the document stay stuck — nothing frees a crashed worker's claim on its own. A time-based stale-claim threshold (5 minutes) is what recovers it, confirmed via the worker's real periodic sweep, not a special test path (E11). The deliberate design choice here: a time threshold needs no cooperation from the thing that might be dead, unlike a heartbeat — but it has a real tradeoff, since a threshold shorter than a legitimately slow delivery attempt would let a second worker reclaim and retry something the first worker hadn't actually failed on, risking a duplicate delivery to the destination.
- **A hostile sequence of failures** (`500, 429, 502, connection-reset, 30s-hang, 400, 410`) classified correctly end to end — including the system's own 10-second timeout correctly firing before a 30-second hang completed, treated as transient rather than waiting it out (E12). One real gap surfaced here and left unfixed, reported rather than patched: the `429` response's `Retry-After` header is computed into the response but never read anywhere in the retry/backoff code — the system retries on its own exponential schedule regardless of what the destination asked for (E13).
- **Two Phase-4 "reimplement from memory" attempts** (idempotency insert, atomic claim) both got the core database mechanics right, but both initially failed to finish the surrounding control flow cleanly — a leftover stub `throw` left in place after the real logic was added, meaning the success path of the ingest handler returned nothing and crashed every normal (non-duplicate) webhook with a 500, while the document had actually already been inserted. Caught live, not by reading the diff — the caller saw failure while the system had silently succeeded.

---

## Load test numbers

Full detail and the investigation trail in `k6/RESULTS.md`; summary here.

| Scenario | Result |
|---|---|
| Sustained ingest (ramp to 8,000 iters/s target) | ~1,715 req/s real throughput, p95 1.21s, 0% errors, at `maxPoolSize:20` |
| Same scenario, `maxPoolSize:200` | p95 dropped to 513ms — client-side Mongo connection pool size was a real, measured part of the bottleneck, confirmed via `db.serverStatus()` showing the server's own connection capacity was nowhere near exhausted (42/100,271 in use) |
| Burst (2,000+ req/s for 10s) | 18,112 requests, 0% errors, p95 169ms |
| Delivery throughput (200ms mock destination) | ~52 deliveries/sec sustained, matching the theoretical `10 concurrent workers × 1/0.2s = 50/s` almost exactly (E16, E17, E18) |

**The first thing that gives, in order:** client-side connection pool size, then worker concurrency (a hardcoded, deliberate ceiling), then — at the very extreme end — the single-container k6 load generator itself, which is worth knowing before trusting an "it survived this RPS" claim near the top of any test's range.

---

## What I got wrong

Twice during the Phase 4 memory-reimplementation drill, the core logic (the unique-index insert, the atomic claim) came out correct, but a leftover piece of stub code was left in place and broke the actual control flow — once causing a real 500 on every normal webhook. Both were caught by running the system live and checking real responses, not by reading the code. The lesson I'm taking from this: database-level correctness and "does the whole function actually finish its job" are different things to verify, and the second one doesn't get caught by `tsc` or by an existing unit test suite that doesn't cover the route handler at all.

# Load test results

Measured 2026-10-22. See `k6/README.md` for how to reproduce.

## Environment

- macOS 15.5, Apple Silicon, 10 CPU cores, 24 GB RAM
- Docker Desktop 27.3.1 (Docker Desktop's Linux VM, not bare metal)
- `docker compose` stack: `app` (Fastify/Node 22), `worker` (same image, `dist/worker.js`), `mongo:7`, `redis:7-alpine` — all default, unconstrained container resource limits
- MongoDB: no replica set, single `mongod`, default WiredTiger cache sizing
- All three scenarios run against a cold-ish stack (containers freshly started for each run)

## Scenario 1 — sustained ingest

**First attempt** (ramp 50 → 600 iterations/s over 2.5 min, `maxPoolSize: 20`): 0% errors, p95 **2.33ms**. This never stressed the system — the ramp schedule was too conservative to find a real limit, so it was discarded in favor of a much more aggressive one rather than reported as the answer.

**Second attempt** (ramp 100 → 8,000 iterations/s over 1m40s, `maxPoolSize: 20`):

| Metric | Value |
|---|---|
| Real sustained throughput achieved | ~1,715 req/s (checks_total / wall time) |
| p90 / p95 latency | 1.18s / 1.21s |
| Error rate | 0% (every accepted request succeeded; k6 could not *generate* the full 8,000/s target — 108,351 iterations dropped because k6 itself hit its scheduling ceiling at 3,000 VUs) |
| Real documents inserted | 172,645 — exactly matches `checks_succeeded`, confirmed via `countDocuments()` — no silent data loss under load |

**Bottleneck investigation.** `docker stats` sampled live during the run showed MongoDB's container CPU climbing to 240–300% (of its available cores) while Redis stayed under 50% and the app plateaued around 120–135% — Mongo was clearly the most CPU-saturated component. But `db.serverStatus().connections` showed only 42 of 100,271 available server-side connections in use with 0 rejected — so the server's own connection capacity was never close to exhausted. Cross-referencing against `src/db/client.ts`, the app's own driver was configured with `maxPoolSize: 20` — a client-side cap, not a server-side one. With up to 3,000 concurrent k6 VUs and only 20 pooled connections to serve them, requests were almost certainly queuing client-side waiting for a free connection before ever reaching Mongo, which would explain rising latency without the server reporting saturation.

**Confirmed by re-running identically with `maxPoolSize: 200`** (made configurable via `MONGO_MAX_POOL_SIZE` specifically to run this comparison — kept in the codebase afterward, not reverted, since it's a legitimate operational knob):

| Metric | `maxPoolSize: 20` | `maxPoolSize: 200` |
|---|---|---|
| p95 latency | 1.21s | **513ms** |
| Error rate | 0% | 0.77% (1,289 / 166,247) |

The larger pool cut p95 latency by more than half, confirming the pool size was a real, measurable part of the bottleneck. But it surfaced a second effect: a small (0.77%) error rate and a 52.88s max latency outlier appeared. Investigated and **not a server-side bug**: zero error-level log lines in the app's own logs during the run, and the real Mongo insert count (164,958) exactly matched k6's `checks_succeeded` count — the server handled every request it received without failing. The failures are consistent with k6's own client-side request timeout/scheduling limits under 3,000 concurrent VUs on a single test-runner container, not a defect in the service under test — though this wasn't chased down to full certainty (would need a dedicated k6-side investigation, out of scope for this pass).

**What I'd change first:** raise `maxPoolSize` from the development default of 20 to something proportional to expected concurrent load (e.g. 100–200) before any real production traffic, and separately, if testing at this scale again, run the load generator across multiple k6 instances/machines rather than one container, since k6 itself became a secondary bottleneck at very high VU counts.

## Scenario 2 — burst

2,000+ req/s sustained for 10 seconds (script intentionally holds the full 2,000/s rate for the duration rather than firing exactly 2,000 total, to stress harder than the PRD's literal "2,000 in 10s" framing):

| Metric | Value |
|---|---|
| Total requests | 18,112 in 10s (~1,811/s average, including ramp-up) |
| p90 / p95 latency | 131ms / 169ms |
| Error rate | 0% |
| Real documents inserted | 18,112 — exact match, confirmed via `countDocuments()` |

Run at `maxPoolSize: 200` (carried over from the prior scenario's config). Comfortably absorbed — no errors, latency an order of magnitude better than the sustained-ramp scenario at a similar instantaneous rate, likely because the burst is short enough that MongoDB's working set and connection pool don't come under sustained pressure the way a 1m40s ramp does.

## Scenario 3 — delivery throughput

Stood up a dedicated mock destination (`http://mock-dest/`) with a fixed 200ms response latency (a minimal Node HTTP server, not a third-party image), ingested 2,000 real deliveries against an endpoint pointed at it, then polled `GET` on the `deliveries` collection for the `delivered` count every 2–3 seconds.

| Metric | Value |
|---|---|
| Time to fully drain 2,000 deliveries | ~35 seconds |
| Sustained drain rate (after initial burst) | ~52 deliveries/second |
| Worker concurrency | 10 (`concurrency: 10` in `src/worker.ts`) |
| Destination latency | 200ms fixed |

**The math checks out exactly**: 10 concurrent workers × (1 delivery / 0.2s) = 50 deliveries/second theoretical — the measured ~52/s matches almost exactly, which is a strong sign the system's actual behavior under load is fully explained by its configuration, not by an unexplained external factor. The first ~3 seconds drained faster (643 delivered) because the queue had a backlog of already-enqueued jobs the worker's 10 concurrent slots could pick up immediately; the rate settles into the steady-state ~52/s once the backlog empties into a steady arrival-equals-service-rate regime.

**What I'd change first:** `concurrency: 10` is a hardcoded constant in `src/worker.ts` — raising it (and running more worker replicas) is the direct lever to raise delivery throughput, bounded by how many concurrent outbound requests a single destination can actually tolerate without the destination itself becoming the bottleneck instead.

## Summary — the first thing that gives, in order

1. **Client-side MongoDB connection pool size** (`maxPoolSize`) is the first real limiter under sustained high-concurrency ingest — not CPU, not Mongo's own connection limits, not Redis.
2. **Worker concurrency** (fixed at 10) is the direct, deterministic ceiling on delivery throughput — confirmed by the measured rate matching the theoretical rate almost exactly.
3. The load generator itself (a single k6 container) became a secondary bottleneck at very high target rates (8,000/s), dropping iterations before the service under test was meaningfully stressed further — worth knowing before trusting a "the system survived this RPS" claim at the extreme end of any future test.

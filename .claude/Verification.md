# Webhook Inspector: Verification and Ownership Plan

Companion to `Webhook Inspector PRD.md`. The system is built. This document covers
turning a built repo into knowledge that survives interview follow-ups.

---

## 0. Rules of engagement (read first)

This file is written for Claude Code operating on this repo, with Saumya reviewing.

**The goal is not a working system. The system already works. The goal is that Saumya
can explain every design decision in it from memory, under follow-up questions, without
the repo open.**

Therefore:

1. **Report, do not repair.** When a check below fails, report the finding with evidence
   and stop. Do not silently fix it. A divergence from the PRD is information about what
   needs to be understood, and fixing it quietly destroys that information.
2. **Evidence over assertion.** "The unique index exists" is not acceptable. The output of
   `db.deliveries.getIndexes()` is. Every claim in this document's output must be paste-able
   command output.
3. **Do not write the two critical paths.** The idempotency compare-and-set and the atomic
   claim are reimplemented by hand in Phase 4. Do not rewrite, refactor, or "improve" them
   outside that phase.
4. **Never show a passing test without showing it can fail.** Break the thing under test,
   confirm the test goes red, restore, confirm green. An untested test is not evidence.
   (Same standard used on Ordessa.)
5. **Record everything in `EVIDENCE.md`** (format in section 7). Nothing goes in the write-up
   or on the resume unless it has a row in that file.

---

## 1. Phase 1: Conformance audit against the PRD

Agents substitute. The resume bullet must describe the code, not the spec. Find every place
the build diverges from the PRD before anything else.

### 1.1 Checks to run

| #   | Check                            | How                                                                       | Pass condition                                                                                                                                                              |
| --- | -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Driver, not ODM                  | `grep -ri "mongoose" package.json src/`                                   | No matches. Official `mongodb` driver only.                                                                                                                                 |
| 2   | Indexes actually created         | `mongosh` → `db.deliveries.getIndexes()` and `db.endpoints.getIndexes()`  | All 8 PRD indexes present on the live collection, not just declared in code                                                                                                 |
| 3   | Idempotency index is unique      | Same output as #2                                                         | `idempotency_key` entry shows `unique: true`                                                                                                                                |
| 4   | Partial index is partial         | Same output                                                               | `verification.status` index shows `partialFilterExpression`                                                                                                                 |
| 5   | Sparse index is sparse           | Same output                                                               | `request.body_parsed.type` index shows `sparse: true`                                                                                                                       |
| 6   | TTL index exists                 | Same output                                                               | `expires_at` index shows `expireAfterSeconds`                                                                                                                               |
| 7   | Claim is atomic                  | Read the delivery worker                                                  | A single `findOneAndUpdate` with `status: 'queued'` in the **filter**. Not a `findOne` followed by an `updateOne`. Not wrapped in a transaction.                            |
| 8   | Idempotency is compare-and-set   | Read the ingest path                                                      | `insertOne` (or upsert) relying on the unique index to reject duplicates, with the `E11000` duplicate-key error caught and handled. Not a `findOne`-then-`insertOne` check. |
| 9   | Attempts array is capped         | Read the schema and the retry path                                        | `$push` with `$slice` (cap 20) **and** a separate `attempt_count` incremented with `$inc`                                                                                   |
| 10  | Ingest returns before processing | Read the route handler                                                    | Response sent before delivery work begins. Confirm the status code matches the PRD.                                                                                         |
| 11  | Retry classification exists      | Read the retry logic                                                      | Permanent vs transient distinguished by an explicit rule, with jitter on backoff. Not blanket retry-everything.                                                             |
| 12  | Metrics registered               | `curl localhost:<port>/metrics`                                           | All 7 PRD metrics present and non-zero after traffic                                                                                                                        |
| 13  | MCP tools run live               | Invoke each of the 5 tools                                                | Each returns real data from the running database                                                                                                                            |
| 14  | No committed secrets             | `git log -p \| grep -iE "api[_-]?key\|secret\|password\|mongodb\+srv://"` | No live credentials in history. (This was a real finding in `coresight-hubspot-connection`. Check it here.)                                                                 |

### 1.2 Output of Phase 1

A markdown table: check number, pass/fail, the command output that proves it, and for each
failure, what was built instead and the one-line reason it matters. No fixes yet.

---

## 2. Phase 2: The explain() drill

This phase is Saumya's to run, not Claude Code's. Claude Code's job: seed realistic data,
provide the exact queries, and hold the answers back until after each attempt.

### 2.1 Seed first

Generate enough data that a collection scan is visibly slower than an index scan.
Target: 200k+ documents in `deliveries`, spread across 20+ endpoints, with a realistic
status distribution (most `delivered`, some `queued`, some `failed`, a few `delivering`).
Low cardinality on `status`, high cardinality on `idempotency_key` and `trace_id`.

### 2.2 For each of the 8 indexes

Run the query that index exists to serve, with `.explain('executionStats')`, and record:

- `winningPlan.stage` (expect `IXSCAN`, or `FETCH` over `IXSCAN`)
- `executionStats.nReturned`
- `executionStats.totalKeysExamined`
- `executionStats.totalDocsExamined`
- `executionStats.executionTimeMillis`
- Whether a `SORT` stage appears (if it does, the index is not serving the sort)

Then **drop the index, re-run the identical query, record the same fields, and put it back.**
The before/after pair is the evidence. A `COLLSCAN` with `totalDocsExamined: 200000` next to
an `IXSCAN` with `totalDocsExamined: 40` is the whole lesson.

### 2.3 The queries

```js
// 1. idempotency_key (unique) - duplicate detection on ingest
db.deliveries
  .find({ idempotency_key: "<real key from the data>" })
  .explain("executionStats");

// 2. endpoint_id + received_at desc - endpoint timeline
db.deliveries
  .find({ endpoint_id: "<id>" })
  .sort({ received_at: -1 })
  .limit(50)
  .explain("executionStats");

// 3. status + next_retry_at - the retry sweep. THE important one.
db.deliveries
  .find({ status: "queued", next_retry_at: { $lte: new Date() } })
  .sort({ next_retry_at: 1 })
  .limit(100)
  .explain("executionStats");

// 4. endpoint_id + status + received_at desc - filtered timeline
db.deliveries
  .find({ endpoint_id: "<id>", status: "failed" })
  .sort({ received_at: -1 })
  .limit(50)
  .explain("executionStats");

// 5. verification.status (partial) - signature failures
db.deliveries
  .find({ "verification.status": "failed" })
  .sort({ received_at: -1 })
  .explain("executionStats");

// 6. trace_id - single-request lookup
db.deliveries.find({ trace_id: "<id>" }).explain("executionStats");

// 7. request.body_parsed.type (sparse) - event-type filter
db.deliveries
  .find({ "request.body_parsed.type": "<type>" })
  .explain("executionStats");

// 8. expires_at (TTL) - not query-serving; verify by behavior in Phase 3
```

### 2.4 The ESR question

Query 3 is the one most likely to be asked about, because `{ status: 1, next_retry_at: 1 }`
is a design decision with a defensible reason and a wrong alternative.

Run it with the index as specced. Then **create the reversed index
`{ next_retry_at: 1, status: 1 }`, drop the original, re-run, and compare
`totalKeysExamined`.** Restore afterwards.

Saumya must be able to answer, from memory and without the repo:

- Why equality before range (ESR)
- What `totalKeysExamined` does under the reversed index and why
- Whether the sort is still served under the reversed index
- What changes if `status` had high cardinality instead of five values

Claude Code: pose these as questions after the measurement, grade the answers against the
recorded numbers, and name what was missed. Do not supply the answer first.

---

## 3. Phase 3: Failure experiments

Measured failures. Each one produces an answer that begins "I measured what happens when"
rather than "in theory." Run each, record the real error text and the real document state.

### 3.1 Duplicate replay without the guard

1. Record `db.deliveries.countDocuments()`.
2. Drop the unique index on `idempotency_key`.
3. Replay the same webhook payload 500 times, concurrently (not sequentially: concurrency
   is the point).
4. Count again. Record how many duplicates landed.
5. Recreate the unique index. Note whether creation **fails** because duplicates now exist,
   and what that error says. This is a real operational lesson: you cannot add a unique
   index to dirty data.
6. Clean up, recreate the index, replay again. Record the exact `E11000` error text and
   confirm the handler treats it as "already seen" rather than an error.

Record: duplicate count without the index, the index-creation failure text, the `E11000`
text, and the final document count with the guard in place.

### 3.2 Worker killed mid-claim

1. Claim a delivery, then `SIGKILL` the worker before it completes (not `SIGTERM`: no
   graceful shutdown, that is the scenario).
2. Inspect the document. Record the `status` and `claimed_at`.
3. Confirm no other worker picks it up while `claimed_at` is recent.
4. Either wait out the stale threshold or backdate `claimed_at`, then run the recovery sweep.
5. Record the document before and after recovery.

Record: the stuck-document state, the threshold value, and the state transition on recovery.
Then answer: why a time-based threshold rather than a heartbeat, and what breaks if the
threshold is shorter than the longest legitimate delivery attempt.

### 3.3 The 16MB wall

1. Copy one delivery document to a scratch collection.
2. Push attempt records onto its `attempts` array in a loop, **uncapped**, until the write
   fails.
3. Record the exact error, the attempt count at failure, and the document size
   (`Object.bsonsize(doc)`) just before it.
4. Then show the capped version absorbing 10,000 attempts with `attempt_count` still
   accurate and document size flat.

Record: the error text, the failure threshold, and the size comparison. This is the schema
design story. Do not skip it because the capped version already works.

### 3.4 TTL timing

1. Insert a document with `expires_at` a minute in the past.
2. Poll for its deletion, recording elapsed time.
3. Record how long it actually took.

The answer worth having: the TTL monitor runs on an interval, so expiry is eventual and not
at the timestamp. Knowing that distinguishes someone who used TTL indexes from someone who
read about them.

### 3.5 Retry classification under a hostile receiver

Stand up a receiver that returns, in order: `500`, `429` with `Retry-After`, `502`,
connection reset, a 30-second hang, `400`, `410`.

Record, for each: whether it was retried, the computed next attempt time, and the final
status. Confirm the 4xx cases are not retried, the hang hits the timeout and is treated as
transient, and `Retry-After` is honoured rather than overridden by the backoff formula.

---

## 4. Phase 4: Reimplement from memory

The two paths an interviewer will go after, in roughly 40 lines total.

Procedure, run by Claude Code:

1. Copy the current implementation of (a) the idempotency compare-and-set and (b) the atomic
   claim to a location Saumya cannot see.
2. Delete both from the working tree.
3. Saumya writes both again from memory. No reference, no autocomplete assistance, no
   searching the repo.
4. Diff against the originals. Run the test suite against the hand-written version.
5. Report every difference, and classify each as: cosmetic, a real behavioural difference,
   or a correctness bug.

Anything in the third category is exactly what would have surfaced in the interview instead.
Repeat the drill until both paths come out correct on the first attempt.

---

## 5. Phase 5: Load test with published numbers

Three k6 scenarios from the PRD. The point is having real numbers instead of arguing from
"burst-shaped, not sustained."

Record for each scenario:

- Arrival rate and duration
- Ingest latency p50 / p95 / p99
- Sustained throughput (accepted events per second)
- Error rate, and which errors
- Queue depth over time: did it drain, or grow without bound
- Mongo-side: slow query log entries, connection pool saturation, lock contention

Then one deliberate degradation: raise arrival rate until something gives, and record **what
gives first** (connection pool, event loop lag, write throughput, retry backlog). Knowing the
first bottleneck by measurement is a senior answer. Guessing it is not.

Publish the numbers in the README with the hardware and Mongo configuration they were
measured on. Numbers without context are not credible.

---

## 6. Phase 6: Write-up and resume claims

Only after Phases 1 to 5 are recorded.

The write-up covers, in this order: what the system does, the three or four design decisions
with the reasoning and the measurement behind each, what was deliberately left out and why
(no Kafka, no Kubernetes, no GraphQL, with the reasoning), what broke under the failure
experiments and what that changed, and the load numbers.

**Claim gate.** Every resume or write-up sentence must map to a row in `EVIDENCE.md`. For
each proposed claim, state the row it rests on. If there is no row, the claim does not ship.

Also flag, explicitly: anything the build does that Saumya cannot yet explain. That list is
the remaining work, and it is more useful than the finished write-up.

---

## 7. EVIDENCE.md format

One row per verified fact. This file is the source of truth for what can be claimed.

```
| ID | Claim | How verified | Evidence (command + key output) | Date |
|----|-------|--------------|---------------------------------|------|
| E1 | Unique index on idempotency_key rejects concurrent duplicates | 500 concurrent replays | `getIndexes()` shows unique:true; 499 E11000, 1 insert; countDocuments +1 | 2026-10-15 |
| E2 | Retry sweep index serves both filter and sort | explain() with and without | IXSCAN totalKeysExamined 112 / nReturned 100; no SORT stage. Reversed index: 4,318 keys examined | 2026-10-15 |
```

---

## 8. Question bank the code must survive

Generated from what the build actually contains, once Phase 1 is done. Seeds:

**Idempotency**

- Two identical webhooks arrive 5ms apart on two workers. Walk through what happens, in order.
- Why a unique index rather than a check-then-insert?
- What is the idempotency key derived from, and what happens when a provider does not send one?
- Why not a transaction?
- When does the key get invalidated, and why does it need to?

**The claim**

- Why `findOneAndUpdate` instead of find then update?
- Two workers call it on the same document simultaneously. What does each receive?
- A worker dies after claiming. How long is that document stuck, and what frees it?
- Why a time threshold instead of a heartbeat?

**Schema and indexes**

- Why is the attempts array capped, and what happens if it is not?
- `attempt_count` duplicates information already in the array. Why keep both?
- Why `{status, next_retry_at}` and not the reverse? What did you measure?
- Why embed the request body rather than reference it?
- Which of your indexes is the least useful, and how would you know?

**Delivery and retries**

- Which failures are retried and which are not? Where is that decision made?
- Why jitter?
- The receiver is down for six hours. What does the system look like when it comes back?
- A receiver is slow but not failing. What happens to everything behind it?

**Scale and operations**

- What is the first thing that breaks under load? How do you know?
- An endpoint is receiving 100x normal traffic. What do you see, and what do you do?
- A delivery is reported missing. Trace it with the tools you built.

**Deliberate omissions**

- Why no queue broker?
- Why MongoDB for this and not Postgres?
- What would you change to run it across multiple instances?

For each: Saumya answers first, Claude Code grades against the recorded evidence, names what
was missed, and does not supply the answer before the attempt.

---

## 9. Anti-patterns to flag on sight

If any of these are in the build, they are findings for the Phase 1 report, not things to
quietly correct:

- Mongoose or any ODM
- Indexes declared in code but absent from the live collection
- `findOne` then `insertOne` as a duplicate check
- `findOne` then `updateOne` as a claim
- A transaction standing in for the compare-and-set
- Unbounded `$push` onto `attempts`
- Blanket retry with no permanent/transient distinction
- Fixed backoff with no jitter
- Processing started before the ingest response is sent
- `catch` blocks that return an error object instead of throwing
- Credentials in any committed file, including compose and deploy files
- Tests asserting on mocks rather than on database state

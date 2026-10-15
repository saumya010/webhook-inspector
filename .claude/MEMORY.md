# Project Memory — Webhook Delivery Inspector

Persistent decision log. Updated after every major change or decision, per `.claude/CLAUDE.md`.

---

## 2026-10-15 — M1 built

Scaffolded and verified M1 per `PRD.md` §13: TypeScript (`strict: true`), Fastify, MongoDB official driver (no Mongoose), `endpoints`/`deliveries` collections with the full §5.5 index set, `/ingest/:slug` with per-scheme signature verification (Stripe, GitHub, generic HMAC) and idempotent insert via unique index, management API (endpoints CRUD, deliveries list/detail/replay/stats), `/healthz`/`/readyz`, Docker Compose stack (app + mongo). 35 Vitest unit tests (signature verification, idempotency derivation, retry classification, backoff/jitter).

Verified live (not just typechecked): fresh `docker compose up --build`, real HTTP round trips — valid signed webhook accepted, exact duplicate replay correctly returned `duplicate: true` with the same `delivery_id`, invalid signature rejected 401, unknown endpoint 404, oversized payload 413, delivery list/stats endpoints returned real data.

One undocumented judgment call: HTTP 3xx responses are classified `permanent` in `src/delivery/retry.ts` — the PRD's §7.3 table only specifies 2xx/408/429/5xx/other-4xx. Flagged, not yet reviewed against the PRD by the user.

## 2026-10-15 — `.claude/CLAUDE.md` and `.claude/Verification.md` found

User has a separate, more rigorous verification plan in `.claude/Verification.md` governing how this project is to be audited and turned into interview-ready evidence. Key rules binding my behavior on this project going forward:

- **Report, don't repair.** Divergences from the PRD found during verification are reported with evidence and left alone — not silently fixed.
- **Evidence over assertion.** Every claim needs paste-able command output (e.g. real `getIndexes()` output), not a description of what the code does.
- **The two critical paths (idempotency compare-and-set, atomic claim) are off-limits to me outside Phase 4** of Verification.md, where the user reimplements them from memory and I diff/grade — I do not rewrite or "improve" them elsewhere.
- **Never delete/overwrite without explicit approval**, stating why and what's being removed, per `.claude/CLAUDE.md`.
- In Phases 2 and 8 of Verification.md (the ESR drill and the question bank), the user answers first — I do not supply answers before their attempt.

Current status: Phase 1 (conformance audit against the PRD) about to run for the first time, against the M1 build above.

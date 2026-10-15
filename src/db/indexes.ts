import type { Db } from "mongodb";

/**
 * Index design is documented in PRD §5.5. Two decisions worth re-reading
 * before touching this file:
 *
 * - { status: 1, next_retry_at: 1 } follows ESR (Equality field before
 *   Range field). The retry scanner queries status == 'queued' with
 *   next_retry_at <= now — reversing the key order breaks the seek.
 * - The sparse index on request.body_parsed.type only indexes documents
 *   where that field exists (not every provider sets `type`). A dense
 *   index here would be mostly empty space.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const deliveries = db.collection("deliveries");
  const endpoints = db.collection("endpoints");

  await Promise.all([
    deliveries.createIndex({ idempotency_key: 1 }, { unique: true, name: "uniq_idempotency_key" }),
    deliveries.createIndex({ endpoint_id: 1, received_at: -1 }, { name: "by_endpoint_recent" }),
    deliveries.createIndex({ status: 1, next_retry_at: 1 }, { name: "retry_scanner_esr" }),
    deliveries.createIndex(
      { endpoint_id: 1, status: 1, received_at: -1 },
      { name: "filtered_list" },
    ),
    deliveries.createIndex(
      { "verification.status": 1, received_at: -1 },
      {
        name: "failed_verification_partial",
        partialFilterExpression: { "verification.status": "failed" },
      },
    ),
    deliveries.createIndex({ trace_id: 1 }, { name: "by_trace_id", sparse: true }),
    deliveries.createIndex(
      { expires_at: 1 },
      { name: "ttl_expiry", expireAfterSeconds: 0 },
    ),
    deliveries.createIndex(
      { "request.body_parsed.type": 1 },
      { name: "by_provider_event_type_sparse", sparse: true },
    ),
    endpoints.createIndex({ slug: 1 }, { unique: true, name: "uniq_slug" }),
  ]);
}

import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import type { DeliveryDoc } from "../types/models.js";

const STALE_CLAIM_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes, per PRD §7.2

/**
 * Atomically claims a delivery for processing. `status: 'queued'` in the
 * FILTER (not read-then-check in application code) is what makes this
 * safe under concurrent workers — MongoDB only lets one findOneAndUpdate
 * match and modify a given document per operation, so if two workers race
 * on the same delivery, exactly one gets a non-null result back and the
 * other gets null. There is no window where both believe they claimed it.
 *
 * Per Verification.md: do not rewrite this outside the formal
 * reimplementation drill (Phase 4).
 */
export async function claimDelivery(deliveryId: string): Promise<DeliveryDoc | null> {
  const deliveries = getDb().collection<DeliveryDoc>("deliveries");
  const result = await deliveries.findOneAndUpdate(
    { _id: new ObjectId(deliveryId), status: "queued" },
    { $set: { status: "delivering", claimed_at: new Date() } },
    { returnDocument: "after" },
  );
  return result;
}

/**
 * Reclaims deliveries stuck in 'delivering' whose claimed_at is older than
 * the stale threshold — the worker that claimed them is presumed dead
 * (crashed, OOM-killed, lost network) rather than still working. Resets
 * them to 'queued' so another worker can pick them up. Without this, a
 * single crashed worker permanently strands every delivery it had claimed.
 */
export async function sweepStaleClaims(): Promise<number> {
  const deliveries = getDb().collection<DeliveryDoc>("deliveries");
  const staleBefore = new Date(Date.now() - STALE_CLAIM_THRESHOLD_MS);

  const result = await deliveries.updateMany(
    { status: "delivering", claimed_at: { $lt: staleBefore } },
    { $set: { status: "queued", claimed_at: null } },
  );
  return result.modifiedCount;
}

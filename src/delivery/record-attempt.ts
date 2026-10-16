import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { MAX_EMBEDDED_ATTEMPTS } from "../types/models.js";
import type { DeliveryAttempt, DeliveryDoc, DeliveryStatus } from "../types/models.js";

/**
 * Pushes an attempt onto the delivery's embedded array, capped at
 * MAX_EMBEDDED_ATTEMPTS via $slice — measured in Phase 3.3 to be the
 * difference between a flat ~6.6KB document after 10,000 attempts and a
 * hard write failure at attempt #56,906 on an uncapped array. attempt_count
 * is incremented separately so the true count survives the cap.
 *
 * nextStatus/nextRetryAt are set in the same update so the whole state
 * transition (attempt recorded + status moved + next retry scheduled) is
 * one atomic write — no window where the document reflects a half-applied
 * transition.
 */
export async function recordAttempt(
  deliveryId: ObjectId,
  attempt: DeliveryAttempt,
  nextStatus: DeliveryStatus,
  nextRetryAt: Date | null,
): Promise<void> {
  const deliveries = getDb().collection<DeliveryDoc>("deliveries");
  await deliveries.updateOne(
    { _id: deliveryId },
    {
      $push: {
        attempts: { $each: [attempt], $slice: -MAX_EMBEDDED_ATTEMPTS },
      },
      $inc: { attempt_count: 1 },
      $set: {
        status: nextStatus,
        next_retry_at: nextRetryAt,
        claimed_at: null,
      },
    },
  );
}

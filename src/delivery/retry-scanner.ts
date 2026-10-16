import { getDb } from "../db/client.js";
import { enqueueDelivery } from "../queue/delivery-queue.js";
import type { DeliveryDoc } from "../types/models.js";

const SCAN_BATCH_SIZE = 100;

/**
 * Finds deliveries whose scheduled retry time has passed and re-enqueues
 * them. This is what the {status, next_retry_at} ESR index (PRD §5.5,
 * measured in the ESR drill) actually serves — a worker recording a
 * retryable failure sets status back to 'queued' with a future
 * next_retry_at, but nothing re-adds a BullMQ job for it on its own.
 * Without this scanner, a scheduled retry is written to the document and
 * then never acted on.
 */
export async function scanDueRetries(): Promise<number> {
  const deliveries = getDb().collection<DeliveryDoc>("deliveries");
  const now = new Date();

  const due = await deliveries
    .find(
      { status: "queued", next_retry_at: { $lte: now } },
      { projection: { _id: 1 }, limit: SCAN_BATCH_SIZE },
    )
    .toArray();

  for (const doc of due) {
    if (doc._id) await enqueueDelivery(doc._id.toString());
  }

  return due.length;
}

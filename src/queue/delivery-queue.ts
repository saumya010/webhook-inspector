import { Queue } from "bullmq";
import { context, propagation } from "@opentelemetry/api";
import { getRedisConnection } from "./connection.js";

export const DELIVERY_QUEUE_NAME = "delivery";

export interface DeliveryJobData {
  delivery_id: string;
  // OTel trace context, carried across the Redis queue boundary. Without
  // this, the worker's webhook.deliver span starts a brand-new trace with
  // no link back to the ingest request that created it — found live: a
  // real delivery's trace in Jaeger only showed the ingest half
  // (webhook.ingest/verify_signature/persist/enqueue); the delivery half
  // (webhook.deliver/mongo.claim/http.request/mongo.record_attempt)
  // existed as a completely separate, unlinked trace.
  trace_carrier?: Record<string, string>;
}

let queue: Queue<DeliveryJobData> | null = null;

export function getDeliveryQueue(): Queue<DeliveryJobData> {
  if (!queue) {
    queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return queue;
}

export async function enqueueDelivery(deliveryId: string, delayMs = 0): Promise<void> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  await getDeliveryQueue().add(
    "deliver",
    { delivery_id: deliveryId, trace_carrier: carrier },
    {
      // The queue job itself doesn't retry — BullMQ's job state isn't the
      // source of truth for delivery attempts, the `deliveries` document
      // is. The worker always marks the job done after one pass, whatever
      // the outcome, and re-enqueues explicitly if a retry is scheduled.
      // See src/worker.ts for why.
      removeOnComplete: true,
      removeOnFail: true,
      // delayMs > 0 is used when a job couldn't acquire its per-endpoint
      // concurrency slot (src/delivery/endpoint-concurrency.ts) — a short
      // delay before retrying avoids a hot loop of claim-release-reenqueue
      // against a busy endpoint.
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    },
  );
}

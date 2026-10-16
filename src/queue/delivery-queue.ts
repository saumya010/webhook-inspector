import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.js";

export const DELIVERY_QUEUE_NAME = "delivery";

export interface DeliveryJobData {
  delivery_id: string;
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

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  await getDeliveryQueue().add(
    "deliver",
    { delivery_id: deliveryId },
    {
      // The queue job itself doesn't retry — BullMQ's job state isn't the
      // source of truth for delivery attempts, the `deliveries` document
      // is. The worker always marks the job done after one pass, whatever
      // the outcome, and re-enqueues explicitly if a retry is scheduled.
      // See src/worker.ts for why.
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

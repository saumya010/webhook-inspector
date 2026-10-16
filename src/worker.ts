import { Worker, type Job } from "bullmq";
import { ObjectId } from "mongodb";
import { connectMongo, getDb } from "./db/client.js";
import { getRedisConnection } from "./queue/connection.js";
import { DELIVERY_QUEUE_NAME, type DeliveryJobData } from "./queue/delivery-queue.js";
import { claimDelivery, sweepStaleClaims } from "./delivery/claim.js";
import { scanDueRetries } from "./delivery/retry-scanner.js";
import { recordAttempt } from "./delivery/record-attempt.js";
import { sendDelivery } from "./delivery/send.js";
import { classifyAttempt, computeBackoffMs } from "./delivery/retry.js";
import type { DeliveryAttempt, DeliveryStatus, EndpointDoc } from "./types/models.js";

const SWEEP_INTERVAL_MS = 60_000; // per PRD §7.2
const RETRY_SCAN_INTERVAL_MS = 5_000; // responsive enough for sub-minute backoffs

async function processDeliveryJob(job: Job<DeliveryJobData>): Promise<void> {
  const deliveryId = job.data.delivery_id;

  // Atomic claim — see src/delivery/claim.ts. A null result means another
  // worker already claimed this delivery, or it's no longer queued (e.g.
  // already delivered). Either way, this worker has nothing to do.
  const delivery = await claimDelivery(deliveryId);
  if (!delivery) return;

  const endpoints = getDb().collection<EndpointDoc>("endpoints");
  const endpoint = await endpoints.findOne({ _id: delivery.endpoint_id });
  const enabledDestinations = endpoint?.destinations.filter((d) => d.enabled) ?? [];

  if (enabledDestinations.length === 0) {
    // No destination configured — nothing to deliver to. Mark delivered
    // rather than leaving it stuck; verification already succeeded and
    // there's no forwarding step to fail.
    await recordAttempt(
      new ObjectId(deliveryId),
      {
        n: delivery.attempt_count + 1,
        started_at: new Date(),
        finished_at: new Date(),
        destination_url: "",
        response_status: null,
        response_time_ms: null,
        error: { type: "no_destination", message: "endpoint has no enabled destinations" },
        classification: "success",
      },
      "delivered",
      null,
    );
    return;
  }

  // Single-destination delivery for M2. Multiple enabled destinations on
  // one endpoint would need a per-destination attempt sub-record — out of
  // scope for this milestone (PRD doesn't specify multi-destination
  // retry semantics), so we deliver to the first enabled one only.
  const destination = enabledDestinations[0];
  if (!destination) return; // unreachable given the length check above, satisfies TS

  const retryPolicy = endpoint?.retry_policy ?? {
    max_attempts: 5,
    backoff_base_ms: 1000,
    backoff_factor: 2,
    max_backoff_ms: 300_000,
  };

  const attemptNumber = delivery.attempt_count + 1;
  const startedAt = new Date();
  const result = await sendDelivery(destination.url, delivery.request.body_raw, {
    "Content-Type": "application/json",
  });

  const classification = classifyAttempt({
    httpStatus: result.httpStatus,
    errorType: result.errorType,
  });

  const attempt: DeliveryAttempt = {
    n: attemptNumber,
    started_at: startedAt,
    finished_at: new Date(),
    destination_url: destination.url,
    response_status: result.httpStatus,
    response_time_ms: result.responseTimeMs,
    error:
      result.errorType !== null
        ? { type: result.errorType, message: result.errorMessage ?? "" }
        : null,
    classification,
  };

  let nextStatus: DeliveryStatus;
  let nextRetryAt: Date | null = null;

  if (classification === "success") {
    nextStatus = "delivered";
  } else if (classification === "permanent" || attemptNumber >= retryPolicy.max_attempts) {
    nextStatus = "dead";
  } else {
    nextStatus = "queued";
    const backoffMs = computeBackoffMs(attemptNumber, retryPolicy);
    nextRetryAt = new Date(Date.now() + backoffMs);
  }

  await recordAttempt(new ObjectId(deliveryId), attempt, nextStatus, nextRetryAt);
}

async function main() {
  await connectMongo();

  const worker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE_NAME,
    processDeliveryJob,
    { connection: getRedisConnection(), concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    // A job throwing is an unexpected bug (DB down, etc.), not a normal
    // delivery failure — normal failures are classified and recorded by
    // processDeliveryJob itself, which never throws for a bad HTTP
    // response. Log loudly; the delivery document's own status is the
    // source of truth for what to do next, not BullMQ's job state.
    console.error(`Delivery job ${job?.id} failed:`, err);
  });

  // Stale-claim sweep: a worker that dies mid-delivery leaves its claimed
  // delivery stuck in 'delivering' forever unless something resets it.
  setInterval(() => {
    sweepStaleClaims().then((count) => {
      if (count > 0) console.log(`Reclaimed ${count} stale delivery claim(s)`);
    }).catch((err) => console.error("Stale-claim sweep failed:", err));
  }, SWEEP_INTERVAL_MS);

  // Retry scanner: a retryable failure sets next_retry_at in the future
  // but doesn't re-add a queue job itself — this is what actually acts on
  // the {status, next_retry_at} index rather than just leaving it unused.
  setInterval(() => {
    scanDueRetries().then((count) => {
      if (count > 0) console.log(`Re-enqueued ${count} due retry(ies)`);
    }).catch((err) => console.error("Retry scan failed:", err));
  }, RETRY_SCAN_INTERVAL_MS);

  console.log("Worker started, listening for delivery jobs");
}

main().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});

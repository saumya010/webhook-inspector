import { startTracing, withSpan } from "./observability/tracing.js";
startTracing(); // must run before any instrumented module is imported

import { Worker, type Job } from "bullmq";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { ObjectId } from "mongodb";
import { createServer } from "node:http";
import { registry } from "./observability/metrics.js";
import { connectMongo, getDb } from "./db/client.js";
import { getRedisConnection } from "./queue/connection.js";
import { DELIVERY_QUEUE_NAME, type DeliveryJobData } from "./queue/delivery-queue.js";
import { claimDelivery, sweepStaleClaims } from "./delivery/claim.js";
import { scanDueRetries } from "./delivery/retry-scanner.js";
import { recordAttempt } from "./delivery/record-attempt.js";
import { sendDelivery } from "./delivery/send.js";
import { classifyAttempt, computeBackoffMs } from "./delivery/retry.js";
import {
  webhookDeliveryAttemptsTotal,
  webhookDeliveryDuration,
  webhookDeliveriesDeadTotal,
  webhookDeliveryQueueDepth,
  timeMongoOp,
} from "./observability/metrics.js";
import type { DeliveryAttempt, DeliveryDoc, DeliveryStatus, EndpointDoc } from "./types/models.js";

const SWEEP_INTERVAL_MS = 60_000; // per PRD §7.2
const RETRY_SCAN_INTERVAL_MS = 5_000; // responsive enough for sub-minute backoffs
const QUEUE_DEPTH_SAMPLE_INTERVAL_MS = 10_000;
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 3001);

async function processDeliveryJob(job: Job<DeliveryJobData>): Promise<void> {
  // Extract the trace context the ingest request injected at enqueue time
  // (src/queue/delivery-queue.ts) so this span is a child of that trace,
  // not a new unlinked one. Falls back to ROOT_CONTEXT (new trace) if the
  // job has no carrier — e.g. jobs enqueued before this change shipped, or
  // bugs in propagation; never throws on a missing/malformed carrier.
  const parentContext = propagation.extract(ROOT_CONTEXT, job.data.trace_carrier ?? {});
  return context.with(parentContext, () =>
    withSpan("webhook.deliver", () => deliverOneAttempt(job)),
  );
}

async function deliverOneAttempt(job: Job<DeliveryJobData>): Promise<void> {
  const deliveryId = job.data.delivery_id;

  // Atomic claim — see src/delivery/claim.ts. A null result means another
  // worker already claimed this delivery, or it's no longer queued (e.g.
  // already delivered). Either way, this worker has nothing to do.
  // Timed from here, not inside claim.ts — that file's logic is a
  // Verification.md Phase 4 drill target and isn't touched outside that
  // drill.
  const delivery = await withSpan("mongo.claim", () =>
    timeMongoOp("deliveries", "claim", () => claimDelivery(deliveryId)),
  );
  if (!delivery) return;

  const endpoints = getDb().collection<EndpointDoc>("endpoints");
  const endpoint = await endpoints.findOne({ _id: delivery.endpoint_id });
  const enabledDestinations = endpoint?.destinations.filter((d) => d.enabled) ?? [];

  if (enabledDestinations.length === 0) {
    // No destination configured — nothing to deliver to. Mark delivered
    // rather than leaving it stuck; verification already succeeded and
    // there's no forwarding step to fail.
    await withSpan("mongo.record_attempt", () =>
      timeMongoOp("deliveries", "record_attempt", () =>
        recordAttempt(
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
        ),
      ),
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
  const endpointSlug = endpoint?.slug ?? "unknown";
  const endDeliveryTimer = webhookDeliveryDuration.startTimer({ endpoint: endpointSlug });
  // Explicit span, not auto-instrumentation: @opentelemetry/instrumentation-http
  // only patches node:http/https — sendDelivery uses the global `fetch`
  // (undici), which that package does not intercept. Checked the package's
  // own description before assuming otherwise.
  const result = await withSpan("http.request", () =>
    sendDelivery(destination.url, delivery.request.body_raw, {
      "Content-Type": "application/json",
    }),
  );
  endDeliveryTimer();

  const classification = classifyAttempt({
    httpStatus: result.httpStatus,
    errorType: result.errorType,
  });
  webhookDeliveryAttemptsTotal.inc({ endpoint: endpointSlug, classification });

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
    webhookDeliveriesDeadTotal.inc({
      endpoint: endpointSlug,
      reason: classification === "permanent" ? "permanent_failure" : "max_attempts_exceeded",
    });
  } else {
    nextStatus = "queued";
    const backoffMs = computeBackoffMs(attemptNumber, retryPolicy);
    nextRetryAt = new Date(Date.now() + backoffMs);
  }

  await withSpan("mongo.record_attempt", () =>
    timeMongoOp("deliveries", "record_attempt", () =>
      recordAttempt(new ObjectId(deliveryId), attempt, nextStatus, nextRetryAt),
    ),
  );
}

const QUEUE_DEPTH_STATES: DeliveryStatus[] = ["queued", "delivering", "failed", "dead"];

async function sampleQueueDepth(): Promise<void> {
  const deliveries = getDb().collection<DeliveryDoc>("deliveries");
  await Promise.all(
    QUEUE_DEPTH_STATES.map(async (state) => {
      const count = await deliveries.countDocuments({ status: state });
      webhookDeliveryQueueDepth.set({ state }, count);
    }),
  );
}

async function main() {
  await connectMongo();

  // The worker is a separate process from the app's Fastify server — its
  // delivery/claim/queue-depth metrics live in their own prom-client
  // registry that nobody can scrape unless the worker exposes it itself.
  // Found live: a real delivery completed end-to-end and its metrics were
  // simply absent from the app's /metrics, because they were recorded in
  // this process, not that one.
  const metricsServer = createServer((req, res) => {
    if (req.url === "/metrics") {
      registry.metrics().then((body) => {
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(body);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  metricsServer.listen(METRICS_PORT, () => {
    console.log(`Worker metrics listening on :${METRICS_PORT}/metrics`);
  });

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

  // Queue depth is a gauge on current state, not an event — sampled
  // periodically from real counts rather than incremented/decremented
  // inline, since "how many deliveries are queued right now" isn't
  // something any single code path owns.
  setInterval(() => {
    sampleQueueDepth().catch((err) => console.error("Queue depth sample failed:", err));
  }, QUEUE_DEPTH_SAMPLE_INTERVAL_MS);

  console.log("Worker started, listening for delivery jobs");
}

main().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});

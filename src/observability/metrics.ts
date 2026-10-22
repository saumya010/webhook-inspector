import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// Every metric below must actually be emitted somewhere in the request/
// delivery path — per PRD §8, defining a metric and never calling it is
// the specific failure mode to avoid (it happened once already: the
// retry-classification logic sat unused for a full milestone before being
// wired into the worker — see .claude/MEMORY.md, M2 build notes).

export const webhookIngestTotal = new Counter({
  name: "webhook_ingest_total",
  help: "Total webhooks ingested",
  labelNames: ["endpoint", "verification_status"] as const,
  registers: [registry],
});

export const webhookIngestDuration = new Histogram({
  name: "webhook_ingest_duration_seconds",
  help: "Time to process an ingest request, from receipt to response",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

export const webhookDeliveryAttemptsTotal = new Counter({
  name: "webhook_delivery_attempts_total",
  help: "Total delivery attempts, by outcome classification",
  labelNames: ["endpoint", "classification"] as const,
  registers: [registry],
});

export const webhookDeliveryDuration = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Time spent delivering to the destination (one attempt)",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

export const webhookDeliveryQueueDepth = new Gauge({
  name: "webhook_delivery_queue_depth",
  help: "Number of deliveries currently in each queue-relevant state",
  labelNames: ["state"] as const,
  registers: [registry],
});

export const webhookDeliveriesDeadTotal = new Counter({
  name: "webhook_deliveries_dead_total",
  help: "Total deliveries that exhausted retries and went dead",
  labelNames: ["endpoint", "reason"] as const,
  registers: [registry],
});

export const mongoOperationDuration = new Histogram({
  name: "mongo_operation_duration_seconds",
  help: "Duration of a MongoDB operation",
  labelNames: ["collection", "operation"] as const,
  registers: [registry],
});

export async function timeMongoOp<T>(
  collection: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const end = mongoOperationDuration.startTimer({ collection, operation });
  try {
    return await fn();
  } finally {
    end();
  }
}

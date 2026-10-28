/**
 * Caps how many deliveries to a single endpoint can be in flight at once,
 * out of the worker's shared pool (`concurrency: 10` in src/worker.ts).
 * Without this, one slow or hung destination can occupy every slot the
 * pool has, starving every other endpoint's deliveries — a real gap
 * confirmed during Phase 8's live question bank (Delivery Q4): the worker
 * pool has no per-destination isolation, and a destination with 8s
 * latency instead of 50ms degrades throughput for unrelated endpoints
 * sharing the same 10 slots.
 *
 * In-process only — each worker replica tracks its own counts. With N
 * replicas, the effective per-endpoint cap is PER_ENDPOINT_MAX × N, same
 * as how total concurrency scales with replica count. A cross-process cap
 * would need a shared counter (e.g. in Redis) — out of scope here; this
 * closes the single-process starvation case, which is what was actually
 * measured.
 */

const PER_ENDPOINT_MAX = 3;

const inFlight = new Map<string, number>();

export function tryAcquireEndpointSlot(endpointId: string): boolean {
  const current = inFlight.get(endpointId) ?? 0;
  if (current >= PER_ENDPOINT_MAX) return false;
  inFlight.set(endpointId, current + 1);
  return true;
}

export function releaseEndpointSlot(endpointId: string): void {
  const current = inFlight.get(endpointId) ?? 0;
  if (current <= 1) {
    inFlight.delete(endpointId);
  } else {
    inFlight.set(endpointId, current - 1);
  }
}

export function getEndpointSlotCount(endpointId: string): number {
  return inFlight.get(endpointId) ?? 0;
}

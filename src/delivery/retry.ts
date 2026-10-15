import type { AttemptClassification } from "../types/models.js";

export interface AttemptOutcome {
  httpStatus: number | null;
  errorType: "network" | "timeout" | null;
}

/**
 * Classifies a delivery attempt result. 2xx is success; 408/429/5xx and any
 * network-level failure are retryable; any other 4xx is permanent — the
 * destination rejected the request and retrying it unchanged won't help.
 * Table-driven on purpose: PRD §10 asks for a table-driven test over every
 * status code, so the production logic should be the same shape.
 */
export function classifyAttempt(outcome: AttemptOutcome): AttemptClassification {
  if (outcome.errorType === "network" || outcome.errorType === "timeout") {
    return "retryable";
  }

  const status = outcome.httpStatus;
  if (status === null) return "retryable";
  if (status >= 200 && status < 300) return "success";
  if (status === 408 || status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "permanent";
}

export interface BackoffPolicy {
  backoff_base_ms: number;
  backoff_factor: number;
  max_backoff_ms: number;
}

/**
 * Exponential backoff with jitter. `attemptNumber` is 1-indexed (the first
 * retry, i.e. the attempt after attempt #1 failed, is attemptNumber = 1).
 *
 * Jitter is ±20% of the computed delay, applied multiplicatively so the cap
 * is still respected after jitter — without it, every failing destination's
 * retries converge on near-identical delays and synchronize into a
 * thundering herd against the queue/worker on the next retry wave.
 *
 * `randomFn` is injectable so backoff-bounds tests can assert exact min/max
 * without depending on Math.random's distribution.
 */
export function computeBackoffMs(
  attemptNumber: number,
  policy: BackoffPolicy,
  randomFn: () => number = Math.random,
): number {
  const raw = policy.backoff_base_ms * Math.pow(policy.backoff_factor, attemptNumber - 1);
  const capped = Math.min(raw, policy.max_backoff_ms);

  const jitterFactor = 0.8 + randomFn() * 0.4; // [0.8, 1.2)
  const jittered = capped * jitterFactor;

  return Math.min(Math.round(jittered), policy.max_backoff_ms);
}

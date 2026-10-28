import { randomUUID } from "node:crypto";
import { getRedisConnection } from "../queue/connection.js";

/**
 * Elects one worker process as leader for the periodic jobs
 * (sweepStaleClaims, scanDueRetries) via a Redis lock with a TTL. Without
 * this, N worker replicas each run their own setInterval loops calling the
 * same idempotent queries redundantly — not incorrect (each query is safe
 * to run concurrently on its own), but wasteful, and the waste scales
 * linearly with replica count. Found as a real gap during Phase 8's live
 * question bank (Deliberate omissions Q3).
 *
 * Renewed on every successful acquisition rather than held indefinitely —
 * if the current leader crashes, the lock expires on its own (LOCK_TTL_MS)
 * and another replica picks it up on its next attempt. No manual failover
 * logic needed; this mirrors the same "time threshold over heartbeat"
 * reasoning already used for stale-claim detection (src/delivery/claim.ts).
 */

const LOCK_KEY = "webhook-inspector:leader-lock";
const LOCK_TTL_MS = 30_000;

const instanceId = randomUUID();

export async function tryBecomeLeader(): Promise<boolean> {
  const redis = getRedisConnection();
  // SET key value NX PX ttl — atomically sets only if the key doesn't
  // exist, or re-sets if we already hold it (via a compare in the Lua
  // script below), with an expiry so a dead leader's lock self-clears.
  // Plain `SET ... NX` alone can't distinguish "I already hold this lock,
  // renew it" from "someone else holds it" — a Lua script makes the
  // check-and-renew atomic instead of racing a separate GET beforehand.
  const result = await redis.eval(
    `
    local current = redis.call("GET", KEYS[1])
    if current == false or current == ARGV[1] then
      redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
      return 1
    end
    return 0
    `,
    1,
    LOCK_KEY,
    instanceId,
    LOCK_TTL_MS.toString(),
  );
  return result === 1;
}

export function getInstanceId(): string {
  return instanceId;
}

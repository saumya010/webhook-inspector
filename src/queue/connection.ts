import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let connection: Redis | null = null;

// BullMQ requires maxRetriesPerRequest: null on the connection it's handed —
// it manages its own retry/backoff semantics for blocking commands and
// conflicts with ioredis's default retry behavior otherwise.
export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getRedisConnection().ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

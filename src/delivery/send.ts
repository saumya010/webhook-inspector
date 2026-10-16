export interface SendResult {
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: "network" | "timeout" | null;
  errorMessage: string | null;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Delivers one HTTP POST to a destination. Network errors and timeouts are
 * both surfaced as errorType so classifyAttempt (src/delivery/retry.ts) can
 * treat them as retryable, same as it does for 5xx — a destination that's
 * unreachable isn't meaningfully different from one returning 503.
 */
export async function sendDelivery(
  destinationUrl: string,
  body: string,
  headers: Record<string, string>,
): Promise<SendResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(destinationUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return {
      httpStatus: response.status,
      responseTimeMs: Date.now() - startedAt,
      errorType: null,
      errorMessage: null,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      httpStatus: null,
      responseTimeMs: Date.now() - startedAt,
      errorType: isAbort ? "timeout" : "network",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

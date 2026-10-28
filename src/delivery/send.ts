export interface SendResult {
  httpStatus: number | null;
  responseTimeMs: number;
  errorType: "network" | "timeout" | null;
  errorMessage: string | null;
  // Parsed from a Retry-After response header, if present — milliseconds
  // from now to wait before the next attempt. null when absent, invalid,
  // or there's no response at all (network/timeout errors).
  retryAfterMs: number | null;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Retry-After is either a number of seconds, or an HTTP-date
 * (RFC 7231 §7.1.3). Returns null for anything else rather than throwing —
 * a malformed header from a destination should degrade to "no hint", not
 * break delivery.
 */
// RFC 7231 §7.1.1.1 IMF-fixdate, the only HTTP-date form worth accepting
// here — strict enough to reject ambiguous short strings that Date.parse
// would otherwise happily (and wrongly) accept, e.g. "-5" parses as a real
// date to the native parser despite being a malformed Retry-After value.
const HTTP_DATE_PATTERN =
  /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  // Entirely numeric (optionally signed) is the delta-seconds form.
  // Anything else is only accepted if it matches the HTTP-date form
  // exactly — no falling through to the native Date.parse's lenient and
  // sometimes surprising interpretation of arbitrary strings.
  if (/^-?\d+$/.test(header)) {
    const seconds = Number(header);
    return seconds >= 0 ? seconds * 1000 : null;
  }

  if (HTTP_DATE_PATTERN.test(header)) {
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return null;
}

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
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      httpStatus: null,
      responseTimeMs: Date.now() - startedAt,
      errorType: isAbort ? "timeout" : "network",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const MAX_PAYLOAD_CHARS = 2000;

/**
 * Tool results are untrusted input to the model (PRD §9) — a delivery's
 * stored request body/headers came from an external webhook provider, not
 * from us, so it can contain arbitrary content (including text crafted to
 * look like instructions). Truncate long payloads so one oversized delivery
 * can't blow the model's context budget, and stringify everything through
 * JSON so object/array structure can't be mistaken for prose by the model
 * reading the tool result.
 */
export function sanitizePayload(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "[unserializable payload]";
  }
  if (json.length > MAX_PAYLOAD_CHARS) {
    return json.slice(0, MAX_PAYLOAD_CHARS) + `...[truncated, ${json.length} chars total]`;
  }
  return json;
}

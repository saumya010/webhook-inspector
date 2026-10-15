import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey } from "../src/verification/idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("stripe: keys on the event id, stable across header/body noise", () => {
    const key1 = deriveIdempotencyKey({
      scheme: "stripe",
      slug: "stripe-test",
      rawBody: '{"id":"evt_123","type":"a"}',
      headers: { "x-request-id": "req_1" },
      parsedBody: { id: "evt_123", type: "a" },
    });
    const key2 = deriveIdempotencyKey({
      scheme: "stripe",
      slug: "stripe-test",
      rawBody: '{"id":"evt_123","type":"a","extra":"noise"}',
      headers: { "x-request-id": "req_2" }, // different header, same event id
      parsedBody: { id: "evt_123", type: "a", extra: "noise" },
    });
    expect(key1).toBe("stripe:evt_123");
    expect(key1).toBe(key2);
  });

  it("stripe: falls back to generic derivation when id is absent", () => {
    const key = deriveIdempotencyKey({
      scheme: "stripe",
      slug: "stripe-test",
      rawBody: '{"type":"a"}',
      headers: {},
      parsedBody: { type: "a" },
    });
    expect(key.startsWith("generic:")).toBe(true);
  });

  it("github: keys on X-GitHub-Delivery header", () => {
    const key = deriveIdempotencyKey({
      scheme: "github",
      slug: "gh-test",
      rawBody: '{"action":"opened"}',
      headers: { "x-github-delivery": "abc-123" },
      parsedBody: { action: "opened" },
    });
    expect(key).toBe("github:abc-123");
  });

  it("generic_hmac: two distinct payloads produce distinct keys", () => {
    const key1 = deriveIdempotencyKey({
      scheme: "generic_hmac",
      slug: "generic-test",
      rawBody: '{"a":1}',
      headers: { "x-webhook-timestamp": "1000" },
      parsedBody: { a: 1 },
    });
    const key2 = deriveIdempotencyKey({
      scheme: "generic_hmac",
      slug: "generic-test",
      rawBody: '{"a":2}',
      headers: { "x-webhook-timestamp": "1000" },
      parsedBody: { a: 2 },
    });
    expect(key1).not.toBe(key2);
  });

  it("generic_hmac: identical payload + timestamp produces the same key (true replay)", () => {
    const input = {
      scheme: "generic_hmac" as const,
      slug: "generic-test",
      rawBody: '{"a":1}',
      headers: { "x-webhook-timestamp": "1000" },
      parsedBody: { a: 1 },
    };
    expect(deriveIdempotencyKey(input)).toBe(deriveIdempotencyKey({ ...input }));
  });
});

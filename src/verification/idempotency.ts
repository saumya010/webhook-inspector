import { createHash } from "node:crypto";
import type { VerificationScheme } from "../types/models.js";

export interface IdempotencyKeyInput {
  scheme: VerificationScheme;
  slug: string;
  rawBody: string;
  headers: Record<string, string>;
  parsedBody: unknown;
}

/**
 * Derives a stable idempotency key per provider. This is the only thing
 * that determines whether a redelivery is treated as new or a duplicate —
 * get this wrong and either duplicates slip through or distinct events
 * collide. See PRD §7.1: the enforcement itself is a unique index, not a
 * check-then-act in application code.
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  switch (input.scheme) {
    case "stripe": {
      const body = input.parsedBody as { id?: unknown } | null;
      if (body && typeof body.id === "string" && body.id.length > 0) {
        return `stripe:${body.id}`;
      }
      // Fall through to generic derivation if Stripe ever sends an event
      // with no id — shouldn't happen, but we never want an empty key.
      return genericKey(input);
    }
    case "github": {
      const deliveryId = input.headers["x-github-delivery"];
      if (deliveryId) return `github:${deliveryId}`;
      return genericKey(input);
    }
    case "generic_hmac":
      return genericKey(input);
  }
}

function genericKey(input: IdempotencyKeyInput): string {
  const timestamp = input.headers["x-webhook-timestamp"] ?? "";
  const hash = createHash("sha256")
    .update(input.slug)
    .update(input.rawBody)
    .update(timestamp)
    .digest("hex");
  return `generic:${hash}`;
}

import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerificationScheme } from "../types/models.js";

export interface VerificationResult {
  passed: boolean;
  failure_reason: string | null;
}

export interface VerifyInput {
  scheme: VerificationScheme;
  secret: string;
  rawBody: string;
  headers: Record<string, string>;
  toleranceSeconds: number;
  now?: Date;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Stripe: `Stripe-Signature: t=<timestamp>,v1=<hmac>`.
// Signed payload is `${t}.${rawBody}`.
function verifyStripe(input: VerifyInput): VerificationResult {
  const header = input.headers["stripe-signature"];
  if (!header) return { passed: false, failure_reason: "missing_signature_header" };

  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) {
    return { passed: false, failure_reason: "malformed_signature_header" };
  }

  const now = input.now ?? new Date();
  const ageSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (ageSeconds > input.toleranceSeconds) {
    return { passed: false, failure_reason: "timestamp_out_of_window" };
  }

  const expected = hmacSha256Hex(input.secret, `${timestamp}.${input.rawBody}`);
  if (!safeEqual(expected, signature)) {
    return { passed: false, failure_reason: "signature_mismatch" };
  }
  return { passed: true, failure_reason: null };
}

// GitHub: `X-Hub-Signature-256: sha256=<hmac>`. No timestamp — GitHub doesn't
// send one, so replay-window enforcement isn't applicable to this scheme.
function verifyGithub(input: VerifyInput): VerificationResult {
  const header = input.headers["x-hub-signature-256"];
  if (!header) return { passed: false, failure_reason: "missing_signature_header" };

  const [algo, signature] = header.split("=");
  if (algo !== "sha256" || !signature) {
    return { passed: false, failure_reason: "malformed_signature_header" };
  }

  const expected = hmacSha256Hex(input.secret, input.rawBody);
  if (!safeEqual(expected, signature)) {
    return { passed: false, failure_reason: "signature_mismatch" };
  }
  return { passed: true, failure_reason: null };
}

// Generic HMAC: `X-Webhook-Signature: <hmac>` + `X-Webhook-Timestamp: <unix_s>`.
// Signed payload is `${timestamp}.${rawBody}`, same shape as Stripe's, since
// that construction is what prevents a captured valid signature from being
// replayed indefinitely.
function verifyGenericHmac(input: VerifyInput): VerificationResult {
  const signature = input.headers["x-webhook-signature"];
  const timestamp = input.headers["x-webhook-timestamp"];
  if (!signature || !timestamp) {
    return { passed: false, failure_reason: "missing_signature_header" };
  }

  const now = input.now ?? new Date();
  const ageSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > input.toleranceSeconds) {
    return { passed: false, failure_reason: "timestamp_out_of_window" };
  }

  const expected = hmacSha256Hex(input.secret, `${timestamp}.${input.rawBody}`);
  if (!safeEqual(expected, signature)) {
    return { passed: false, failure_reason: "signature_mismatch" };
  }
  return { passed: true, failure_reason: null };
}

export function verifySignature(input: VerifyInput): VerificationResult {
  switch (input.scheme) {
    case "stripe":
      return verifyStripe(input);
    case "github":
      return verifyGithub(input);
    case "generic_hmac":
      return verifyGenericHmac(input);
  }
}

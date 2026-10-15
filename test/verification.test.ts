import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/verification/schemes.js";

function stripeSig(secret: string, timestamp: number, body: string): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function githubSig(secret: string, body: string): string {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

function genericSig(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

describe("verifySignature — stripe", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"test"}';

  it("passes with a valid signature inside the tolerance window", () => {
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const result = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      headers: { "stripe-signature": stripeSig(secret, timestamp, body) },
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ passed: true, failure_reason: null });
  });

  it("fails outside the tolerance window (replay rejection)", () => {
    const now = new Date();
    const staleTimestamp = Math.floor(now.getTime() / 1000) - 10_000;
    const result = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      headers: { "stripe-signature": stripeSig(secret, staleTimestamp, body) },
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ passed: false, failure_reason: "timestamp_out_of_window" });
  });

  it("fails on a tampered body", () => {
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const result = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: '{"id":"evt_1","type":"TAMPERED"}',
      headers: { "stripe-signature": stripeSig(secret, timestamp, body) },
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ passed: false, failure_reason: "signature_mismatch" });
  });

  it("fails when the header is missing", () => {
    const result = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      headers: {},
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ passed: false, failure_reason: "missing_signature_header" });
  });
});

describe("verifySignature — github", () => {
  const secret = "github_secret";
  const body = '{"action":"opened"}';

  it("passes with a valid signature", () => {
    const result = verifySignature({
      scheme: "github",
      secret,
      rawBody: body,
      headers: { "x-hub-signature-256": githubSig(secret, body) },
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ passed: true, failure_reason: null });
  });

  it("fails on wrong secret", () => {
    const result = verifySignature({
      scheme: "github",
      secret,
      rawBody: body,
      headers: { "x-hub-signature-256": githubSig("wrong_secret", body) },
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ passed: false, failure_reason: "signature_mismatch" });
  });

  it("fails on malformed header (missing algo prefix)", () => {
    const result = verifySignature({
      scheme: "github",
      secret,
      rawBody: body,
      headers: { "x-hub-signature-256": "not-a-valid-signature" },
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ passed: false, failure_reason: "malformed_signature_header" });
  });
});

describe("verifySignature — generic_hmac", () => {
  const secret = "generic_secret";
  const body = '{"foo":"bar"}';

  it("passes with a valid signature and timestamp", () => {
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const result = verifySignature({
      scheme: "generic_hmac",
      secret,
      rawBody: body,
      headers: {
        "x-webhook-signature": genericSig(secret, timestamp, body),
        "x-webhook-timestamp": String(timestamp),
      },
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ passed: true, failure_reason: null });
  });

  it("fails outside the tolerance window", () => {
    const now = new Date();
    const staleTimestamp = Math.floor(now.getTime() / 1000) - 10_000;
    const result = verifySignature({
      scheme: "generic_hmac",
      secret,
      rawBody: body,
      headers: {
        "x-webhook-signature": genericSig(secret, staleTimestamp, body),
        "x-webhook-timestamp": String(staleTimestamp),
      },
      toleranceSeconds: 300,
      now,
    });
    expect(result).toEqual({ passed: false, failure_reason: "timestamp_out_of_window" });
  });

  it("fails with a non-numeric timestamp", () => {
    const result = verifySignature({
      scheme: "generic_hmac",
      secret,
      rawBody: body,
      headers: {
        "x-webhook-signature": "irrelevant",
        "x-webhook-timestamp": "not-a-number",
      },
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ passed: false, failure_reason: "timestamp_out_of_window" });
  });
});

import { describe, it, expect } from "vitest";
import { classifyAttempt, computeBackoffMs } from "../src/delivery/retry.js";

describe("classifyAttempt", () => {
  const cases: Array<[number | null, "network" | "timeout" | null, string]> = [
    [200, null, "success"],
    [201, null, "success"],
    [299, null, "success"],
    [300, null, "permanent"], // 3xx — destination redirected, not handled, treat as permanent
    [400, null, "permanent"],
    [401, null, "permanent"],
    [403, null, "permanent"],
    [404, null, "permanent"],
    [408, null, "retryable"],
    [429, null, "retryable"],
    [500, null, "retryable"],
    [502, null, "retryable"],
    [503, null, "retryable"],
    [599, null, "retryable"],
    [null, "network", "retryable"],
    [null, "timeout", "retryable"],
  ];

  it.each(cases)("status=%s error=%s -> %s", (httpStatus, errorType, expected) => {
    expect(classifyAttempt({ httpStatus, errorType })).toBe(expected);
  });
});

describe("computeBackoffMs", () => {
  const policy = { backoff_base_ms: 1000, backoff_factor: 2, max_backoff_ms: 300_000 };

  it("is monotonically non-decreasing in expectation before the cap (jitter-free)", () => {
    const noJitter = () => 0.5; // maps to jitterFactor 1.0 exactly
    const d1 = computeBackoffMs(1, policy, noJitter);
    const d2 = computeBackoffMs(2, policy, noJitter);
    const d3 = computeBackoffMs(3, policy, noJitter);
    expect(d1).toBe(1000);
    expect(d2).toBe(2000);
    expect(d3).toBe(4000);
  });

  it("respects the cap even at a high attempt number", () => {
    const noJitter = () => 0.5;
    const result = computeBackoffMs(20, policy, noJitter);
    expect(result).toBeLessThanOrEqual(policy.max_backoff_ms);
    expect(result).toBe(policy.max_backoff_ms);
  });

  it("jitter stays within ±20% of the uncapped computed delay", () => {
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
      const result = computeBackoffMs(1, policy, () => rand);
      // attempt 1 -> raw = base = 1000; jitterFactor in [0.8, 1.2)
      expect(result).toBeGreaterThanOrEqual(800);
      expect(result).toBeLessThanOrEqual(1200);
    }
  });

  it("never exceeds max_backoff_ms even with maximal jitter near the cap", () => {
    const nearCapPolicy = { backoff_base_ms: 250_000, backoff_factor: 2, max_backoff_ms: 300_000 };
    const result = computeBackoffMs(1, nearCapPolicy, () => 0.999);
    expect(result).toBeLessThanOrEqual(300_000);
  });
});

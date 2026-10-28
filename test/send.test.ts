import { describe, it, expect } from "vitest";
import { parseRetryAfter } from "../src/delivery/send.js";

describe("parseRetryAfter", () => {
  it("parses a numeric seconds value", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parses 0 seconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses an HTTP-date in the future", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).not.toBeNull();
    // allow a little slack for test execution time
    expect(result).toBeGreaterThan(55_000);
    expect(result).toBeLessThanOrEqual(60_000);
  });

  it("clamps an HTTP-date in the past to 0, not negative", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("returns null for a missing header", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(parseRetryAfter("not-a-valid-value")).toBeNull();
  });

  it("returns null for a negative seconds value", () => {
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";
import { Rate } from "k6/metrics";

// Scenario 1 (PRD §11): ramp RPS until p99 ingest latency exceeds 500ms, or
// something else gives first. First attempt (50 -> 600 iters/s) never broke
// 500ms p95 (stayed under 3ms) — pushed the ceiling much higher deliberately
// to find a real limit rather than report a number that never stressed the
// system (see k6/RESULTS.md).

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SLUG = __ENV.SLUG || "k6-load-test";
const SECRET = __ENV.SECRET || "k6-load-secret";

const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 3000,
      stages: [
        { target: 500, duration: "20s" },
        { target: 1500, duration: "20s" },
        { target: 3000, duration: "20s" },
        { target: 5000, duration: "20s" },
        { target: 8000, duration: "20s" },
      ],
    },
  },
};

function hmacHex(secret, message) {
  return crypto.hmac("sha256", secret, message, "hex");
}

export default function () {
  const body = JSON.stringify({ event: "k6.sustained2", id: `${__VU}-${__ITER}` });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacHex(SECRET, `${timestamp}.${body}`);

  const res = http.post(`${BASE_URL}/ingest/${SLUG}`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature": signature,
    },
  });

  const ok = check(res, {
    "status is 202": (r) => r.status === 202,
  });
  errorRate.add(!ok);
}

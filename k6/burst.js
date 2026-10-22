import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";
import { Rate } from "k6/metrics";

// Scenario 2 (PRD §11): 2,000 deliveries in 10s — the bulk-batch case.

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SLUG = __ENV.SLUG || "k6-load-test";
const SECRET = __ENV.SECRET || "k6-load-secret";

const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: 2000, duration: "1s" }, // snap to 2000/s instantly
        { target: 2000, duration: "9s" }, // hold — 2000 req/s * 10s ≈ 2000 total intended, see README
      ],
    },
  },
};

function hmacHex(secret, message) {
  return crypto.hmac("sha256", secret, message, "hex");
}

export default function () {
  const body = JSON.stringify({ event: "k6.burst", id: `${__VU}-${__ITER}` });
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

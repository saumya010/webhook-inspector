import type { ObjectId } from "mongodb";

export type VerificationScheme = "stripe" | "github" | "generic_hmac";

export interface EndpointDoc {
  _id?: ObjectId;
  name: string;
  slug: string;
  provider: VerificationScheme;
  verification: {
    scheme: VerificationScheme;
    secret_ref: string;
    tolerance_s: number;
  };
  destinations: Array<{ url: string; enabled: boolean }>;
  retry_policy: {
    max_attempts: number;
    backoff_base_ms: number;
    backoff_factor: number;
    max_backoff_ms: number;
  };
  created_at: Date;
  updated_at: Date;
}

export type DeliveryStatus =
  | "received"
  | "queued"
  | "delivering"
  | "delivered"
  | "failed"
  | "dead";

export type VerificationStatus = "passed" | "failed" | "skipped";
export type AttemptClassification = "success" | "retryable" | "permanent";

export interface DeliveryAttempt {
  n: number;
  started_at: Date;
  finished_at: Date | null;
  destination_url: string;
  response_status: number | null;
  response_time_ms: number | null;
  error: { type: string; message: string } | null;
  classification: AttemptClassification | null;
}

export const MAX_EMBEDDED_ATTEMPTS = 20;

export interface DeliveryDoc {
  _id?: ObjectId;
  endpoint_id: ObjectId;
  idempotency_key: string;

  received_at: Date;

  request: {
    headers: Record<string, string>;
    body_raw: string;
    body_parsed: unknown;
    size_bytes: number;
    source_ip: string;
  };

  verification: {
    status: VerificationStatus;
    scheme: VerificationScheme | null;
    failure_reason: string | null;
    verified_at: Date | null;
  };

  status: DeliveryStatus;

  attempts: DeliveryAttempt[];
  attempt_count: number;

  claimed_at: Date | null;
  next_retry_at: Date | null;
  trace_id: string | null;
  expires_at: Date;
}

// Overflow collection for attempts beyond MAX_EMBEDDED_ATTEMPTS — see §5.4.
export interface DeliveryAttemptOverflowDoc {
  _id?: ObjectId;
  delivery_id: ObjectId;
  attempt: DeliveryAttempt;
}

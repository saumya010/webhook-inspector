import type { FastifyInstance, FastifyRequest } from "fastify";
import { MongoServerError, ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { verifySignature } from "../verification/schemes.js";
import { deriveIdempotencyKey } from "../verification/idempotency.js";
import type { DeliveryDoc, EndpointDoc } from "../types/models.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB cap — PRD §6
const DELIVERY_TTL_DAYS = 30;

function readSecret(secretRef: string): string | undefined {
  return process.env[secretRef];
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function registerIngestRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/ingest/:slug",
    {
      config: {
        // Raw body is captured via the content-type parser override below —
        // re-stringifying JSON changes key order and breaks signatures that
        // were computed over the exact bytes the provider sent.
        rawBody: true,
      },
    },
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply) => {
      const db = getDb();
      const endpoints = db.collection<EndpointDoc>("endpoints");
      const deliveries = db.collection<DeliveryDoc>("deliveries");

      const endpoint = await endpoints.findOne({ slug: request.params.slug });
      if (!endpoint) {
        return reply.code(404).send({ error: "unknown_endpoint" });
      }

      const rawBody = (request as unknown as { rawBody: string }).rawBody ?? "";
      const sizeBytes = Buffer.byteLength(rawBody, "utf8");
      if (sizeBytes > MAX_BODY_BYTES) {
        return reply.code(413).send({ error: "payload_too_large" });
      }

      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v.join(",") : (v ?? ""),
        ]),
      );

      const secret = readSecret(endpoint.verification.secret_ref);
      let verificationStatus: DeliveryDoc["verification"]["status"];
      let failureReason: string | null = null;

      if (!secret) {
        verificationStatus = "skipped";
      } else {
        const result = verifySignature({
          scheme: endpoint.verification.scheme,
          secret,
          rawBody,
          headers,
          toleranceSeconds: endpoint.verification.tolerance_s,
        });
        verificationStatus = result.passed ? "passed" : "failed";
        failureReason = result.failure_reason;

        if (!result.passed) {
          return reply.code(401).send({
            error:
              failureReason === "timestamp_out_of_window"
                ? "timestamp_out_of_window"
                : "invalid_signature",
          });
        }
      }

      const parsedBody = tryParseJson(rawBody);
      const idempotencyKey = deriveIdempotencyKey({
        scheme: endpoint.verification.scheme,
        slug: endpoint.slug,
        rawBody,
        headers,
        parsedBody,
      });

      const now = new Date();
      const expiresAt = new Date(now.getTime() + DELIVERY_TTL_DAYS * 24 * 60 * 60 * 1000);

      const doc: DeliveryDoc = {
        endpoint_id: endpoint._id as ObjectId,
        idempotency_key: idempotencyKey,
        received_at: now,
        request: {
          headers,
          body_raw: rawBody,
          body_parsed: parsedBody,
          size_bytes: sizeBytes,
          source_ip: request.ip,
        },
        verification: {
          status: verificationStatus,
          scheme: endpoint.verification.scheme,
          failure_reason: failureReason,
          verified_at: verificationStatus === "passed" ? now : null,
        },
        status: "received",
        attempts: [],
        attempt_count: 0,
        claimed_at: null,
        next_retry_at: null,
        trace_id: request.headers["x-trace-id"]?.toString() ?? null,
        expires_at: expiresAt,
      };

      try {
        const inserted = await deliveries.insertOne(doc);
        // Enqueueing happens in M2 once BullMQ is wired in; for now the
        // delivery is persisted as `received` and queuing is a no-op.
        return reply.code(202).send({ delivery_id: inserted.insertedId.toString(), duplicate: false });
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          // Duplicate key on idempotency_key — this is a redelivery, not an
          // error. The database arbitrated; no check-then-act was needed.
          const existing = await deliveries.findOne({ idempotency_key: idempotencyKey });
          return reply
            .code(200)
            .send({ delivery_id: existing?._id?.toString() ?? null, duplicate: true });
        }
        throw err;
      }
    },
  );
}

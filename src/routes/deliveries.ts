import type { FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { enqueueDelivery } from "../queue/delivery-queue.js";
import type { DeliveryDoc, DeliveryStatus, VerificationStatus } from "../types/models.js";

interface ListQuery {
  endpoint_id?: string;
  status?: DeliveryStatus;
  verification_status?: VerificationStatus;
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function registerDeliveryRoutes(app: FastifyInstance): Promise<void> {
  const deliveries = () => getDb().collection<DeliveryDoc>("deliveries");

  app.get(
    "/api/deliveries",
    async (request: FastifyRequest<{ Querystring: ListQuery }>, reply) => {
      const q = request.query;
      const filter: Record<string, unknown> = {};

      if (q.endpoint_id) {
        if (!ObjectId.isValid(q.endpoint_id)) {
          return reply.code(400).send({ error: "invalid_endpoint_id" });
        }
        filter.endpoint_id = new ObjectId(q.endpoint_id);
      }
      if (q.status) filter.status = q.status;
      if (q.verification_status) filter["verification.status"] = q.verification_status;

      const receivedAtFilter: Record<string, Date> = {};
      if (q.since) receivedAtFilter.$gte = new Date(q.since);
      if (q.until) receivedAtFilter.$lte = new Date(q.until);
      if (Object.keys(receivedAtFilter).length > 0) {
        filter.received_at = receivedAtFilter;
      }

      // Cursor pagination on (received_at, _id) — stable under concurrent
      // inserts because _id is monotonically increasing and unique, unlike
      // an offset/skip which can double-count or skip rows as new
      // documents are inserted ahead of the current page.
      if (q.cursor) {
        const [receivedAtMs, id] = q.cursor.split("_");
        if (receivedAtMs && id && ObjectId.isValid(id)) {
          filter.$or = [
            { received_at: { $lt: new Date(Number(receivedAtMs)) } },
            {
              received_at: new Date(Number(receivedAtMs)),
              _id: { $lt: new ObjectId(id) },
            },
          ];
        }
      }

      const limit = Math.min(Number(q.limit) || DEFAULT_LIMIT, MAX_LIMIT);

      const docs = await deliveries()
        .find(filter, {
          projection: { "request.body_raw": 0 }, // list view omits raw body — detail view includes it
        })
        .sort({ received_at: -1, _id: -1 })
        .limit(limit)
        .toArray();

      const last = docs[docs.length - 1];
      const nextCursor = last ? `${last.received_at.getTime()}_${last._id?.toString()}` : null;

      return reply.send({ data: docs, next_cursor: nextCursor });
    },
  );

  app.get(
    "/api/deliveries/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      if (!ObjectId.isValid(request.params.id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const doc = await deliveries().findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) return reply.code(404).send({ error: "not_found" });
      return reply.send({ data: doc });
    },
  );

  app.post(
    "/api/deliveries/:id/replay",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      if (!ObjectId.isValid(request.params.id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const id = new ObjectId(request.params.id);
      const doc = await deliveries().findOne({ _id: id });
      if (!doc) return reply.code(404).send({ error: "not_found" });

      // Reset to queued and re-enqueue so a worker picks it up. Both the
      // original status (e.g. 'dead') and the retry/claim fields are
      // cleared in one write — a delivery must never be left half in its
      // old terminal state and half reset.
      await deliveries().updateOne(
        { _id: id },
        { $set: { status: "queued", claimed_at: null, next_retry_at: null } },
      );
      await enqueueDelivery(id.toString());

      return reply.send({ data: { delivery_id: id.toString(), status: "queued" } });
    },
  );

  interface ReplayBulkBody {
    endpoint_id?: string;
    status?: DeliveryStatus;
    since?: string;
    until?: string;
    limit?: number;
  }

  const MAX_REPLAY_BULK = 500;
  const DEFAULT_REPLAY_BULK_LIMIT = 100;

  app.post(
    "/api/deliveries/replay-bulk",
    async (request: FastifyRequest<{ Body: ReplayBulkBody }>, reply) => {
      const body = request.body ?? {};
      const filter: Record<string, unknown> = {
        // Default to 'dead' — bulk-replaying anything else (e.g. currently
        // 'delivering') would be a real correctness hazard, not a
        // convenience. Caller can override explicitly if they really mean
        // to target a different status.
        status: body.status ?? "dead",
      };

      if (body.endpoint_id) {
        if (!ObjectId.isValid(body.endpoint_id)) {
          return reply.code(400).send({ error: "invalid_endpoint_id" });
        }
        filter.endpoint_id = new ObjectId(body.endpoint_id);
      }

      const receivedAtFilter: Record<string, Date> = {};
      if (body.since) receivedAtFilter.$gte = new Date(body.since);
      if (body.until) receivedAtFilter.$lte = new Date(body.until);
      if (Object.keys(receivedAtFilter).length > 0) {
        filter.received_at = receivedAtFilter;
      }

      const limit = Math.min(body.limit ?? DEFAULT_REPLAY_BULK_LIMIT, MAX_REPLAY_BULK);

      // Resolve the exact set of IDs first, then act on that fixed set —
      // an unscoped filter (no endpoint_id, no time range) is a real
      // mass-recovery operation (PRD §15's "6-hour outage" scenario), not
      // something to run as an open-ended updateMany against a moving
      // target. The `limit` bounds blast radius per call; call again for
      // more.
      const targets = await deliveries()
        .find(filter, { projection: { _id: 1 } })
        .limit(limit)
        .toArray();
      const ids = targets.map((d) => d._id).filter((id): id is ObjectId => id !== undefined);

      if (ids.length === 0) {
        return reply.send({ data: { matched: 0, replayed: 0, delivery_ids: [] } });
      }

      await deliveries().updateMany(
        { _id: { $in: ids } },
        { $set: { status: "queued", claimed_at: null, next_retry_at: null } },
      );
      // Enqueue sequentially, not Promise.all — this can be hundreds of
      // jobs; unbounded concurrent BullMQ adds are an unnecessary spike
      // against Redis for an operation that isn't latency-sensitive.
      for (const id of ids) {
        await enqueueDelivery(id.toString());
      }

      return reply.send({
        data: {
          matched: ids.length,
          replayed: ids.length,
          delivery_ids: ids.map((id) => id.toString()),
        },
      });
    },
  );

  app.get(
    "/api/deliveries/stats",
    async (
      request: FastifyRequest<{ Querystring: { endpoint_id?: string; window?: string } }>,
      reply,
    ) => {
      const { endpoint_id, window } = request.query;
      const match: Record<string, unknown> = {};

      if (endpoint_id) {
        if (!ObjectId.isValid(endpoint_id)) {
          return reply.code(400).send({ error: "invalid_endpoint_id" });
        }
        match.endpoint_id = new ObjectId(endpoint_id);
      }

      const windowMs = parseWindow(window ?? "24h");
      match.received_at = { $gte: new Date(Date.now() - windowMs) };

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: { endpoint_id: "$endpoint_id", status: "$status" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.endpoint_id": 1, "_id.status": 1 } },
      ];

      const results = await deliveries().aggregate(pipeline).toArray();
      return reply.send({ data: results });
    },
  );
}

function parseWindow(window: string): number {
  const match = /^(\d+)([hd])$/.exec(window);
  if (!match) return 24 * 60 * 60 * 1000;
  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  const unitMs = unit === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return amount * unitMs;
}

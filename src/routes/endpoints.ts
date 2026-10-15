import type { FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId, MongoServerError } from "mongodb";
import { getDb } from "../db/client.js";
import type { EndpointDoc, VerificationScheme } from "../types/models.js";

interface CreateEndpointBody {
  name: string;
  slug: string;
  provider: VerificationScheme;
  verification?: Partial<EndpointDoc["verification"]>;
  destinations?: EndpointDoc["destinations"];
  retry_policy?: Partial<EndpointDoc["retry_policy"]>;
}

const DEFAULT_RETRY_POLICY: EndpointDoc["retry_policy"] = {
  max_attempts: 5,
  backoff_base_ms: 1000,
  backoff_factor: 2,
  max_backoff_ms: 300_000,
};

export async function registerEndpointRoutes(app: FastifyInstance): Promise<void> {
  const endpoints = () => getDb().collection<EndpointDoc>("endpoints");

  app.get("/api/endpoints", async (_req, reply) => {
    const docs = await endpoints().find().sort({ created_at: -1 }).toArray();
    return reply.send({ data: docs });
  });

  app.get(
    "/api/endpoints/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      if (!ObjectId.isValid(request.params.id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const doc = await endpoints().findOne({ _id: new ObjectId(request.params.id) });
      if (!doc) return reply.code(404).send({ error: "not_found" });
      return reply.send({ data: doc });
    },
  );

  app.post(
    "/api/endpoints",
    async (request: FastifyRequest<{ Body: CreateEndpointBody }>, reply) => {
      const body = request.body;
      if (!body?.name || !body?.slug || !body?.provider) {
        return reply.code(400).send({ error: "missing_required_fields" });
      }

      const now = new Date();
      const doc: EndpointDoc = {
        name: body.name,
        slug: body.slug,
        provider: body.provider,
        verification: {
          scheme: body.verification?.scheme ?? body.provider,
          secret_ref: body.verification?.secret_ref ?? `WEBHOOK_SECRET_${body.slug.toUpperCase()}`,
          tolerance_s: body.verification?.tolerance_s ?? 300,
        },
        destinations: body.destinations ?? [],
        retry_policy: { ...DEFAULT_RETRY_POLICY, ...body.retry_policy },
        created_at: now,
        updated_at: now,
      };

      try {
        const result = await endpoints().insertOne(doc);
        return reply.code(201).send({ data: { ...doc, _id: result.insertedId } });
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          return reply.code(409).send({ error: "slug_already_exists" });
        }
        throw err;
      }
    },
  );

  app.patch(
    "/api/endpoints/:id",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Partial<CreateEndpointBody> }>,
      reply,
    ) => {
      if (!ObjectId.isValid(request.params.id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      const updates: Record<string, unknown> = { updated_at: new Date() };
      for (const key of ["name", "destinations", "retry_policy", "verification"] as const) {
        if (request.body[key] !== undefined) updates[key] = request.body[key];
      }

      const result = await endpoints().findOneAndUpdate(
        { _id: new ObjectId(request.params.id) },
        { $set: updates },
        { returnDocument: "after" },
      );

      if (!result) return reply.code(404).send({ error: "not_found" });
      return reply.send({ data: result });
    },
  );
}

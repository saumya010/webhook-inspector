import type { FastifyInstance } from "fastify";
import { pingMongo } from "../db/client.js";
import { pingRedis } from "../queue/connection.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_req, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  app.get("/readyz", async (_req, reply) => {
    const [mongoOk, redisOk] = await Promise.all([pingMongo(), pingRedis()]);
    if (!mongoOk || !redisOk) {
      return reply.code(503).send({ status: "not_ready", mongo: mongoOk, redis: redisOk });
    }
    return reply.code(200).send({ status: "ready", mongo: true, redis: true });
  });
}

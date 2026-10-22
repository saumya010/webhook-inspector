import type { FastifyInstance } from "fastify";
import { registry } from "../observability/metrics.js";

export async function registerMetricsRoute(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });
}

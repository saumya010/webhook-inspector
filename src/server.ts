import Fastify from "fastify";
import { connectMongo } from "./db/client.js";
import { ensureIndexes } from "./db/indexes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIngestRoute } from "./routes/ingest.js";
import { registerEndpointRoutes } from "./routes/endpoints.js";
import { registerDeliveryRoutes } from "./routes/deliveries.js";

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY;

async function main() {
  // 1MB cap per PRD §6. This happens to match Fastify's own default, but
  // it's set explicitly so the limit is a deliberate product decision, not
  // an accident of the library's defaults.
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });

  // Capture the exact raw bytes of every request body before Fastify's
  // default JSON parser runs. Signature verification is computed over the
  // raw bytes the provider sent — re-serializing parsed JSON can reorder
  // keys or change whitespace and silently break a valid signature.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      (_req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, body === "" ? {} : JSON.parse(body as string));
      } catch {
        // Malformed JSON is still stored as raw text for inspection —
        // ingest doesn't reject on unparseable bodies, only on bad signatures.
        done(null, {});
      }
    },
  );

  // Auth gate for the management API. /ingest/* is intentionally public —
  // the provider's signature is the credential there, per PRD §6.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (!API_KEY) return; // no key configured — auth disabled for local dev

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (token !== API_KEY) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  await connectMongo();
  await ensureIndexes((await connectMongo()));

  await registerHealthRoutes(app);
  await registerIngestRoute(app);
  await registerEndpointRoutes(app);
  await registerDeliveryRoutes(app);

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

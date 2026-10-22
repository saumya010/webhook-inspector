import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { enqueueDelivery } from "../queue/delivery-queue.js";
import { sanitizePayload } from "./sanitize.js";
import type { DeliveryDoc, DeliveryStatus, EndpointDoc } from "../types/models.js";

const MAX_FIND_DELIVERIES_LIMIT = 50;
const DEFAULT_FIND_DELIVERIES_LIMIT = 10;

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "webhook-inspector",
    version: "0.1.0",
  });

  server.registerTool(
    "list_endpoints",
    {
      title: "List endpoints",
      description:
        "List every configured webhook endpoint (name, slug, provider, destination count). " +
        "Use this first when you don't yet know an endpoint's slug or ID — e.g. before " +
        "calling find_deliveries, or when the user refers to an endpoint by name rather than slug.",
      inputSchema: {},
    },
    async () => {
      const endpoints = getDb().collection<EndpointDoc>("endpoints");
      const docs = await endpoints.find().sort({ created_at: -1 }).limit(100).toArray();
      const compact = docs.map((e) => ({
        id: e._id?.toString(),
        name: e.name,
        slug: e.slug,
        provider: e.provider,
        destination_count: e.destinations.length,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
      };
    },
  );

  server.registerTool(
    "find_deliveries",
    {
      title: "Find deliveries",
      description:
        "Search deliveries by endpoint, status, and/or time range. Returns compact summaries " +
        "(id, status, received_at, attempt_count, last error) — not full request/response bodies. " +
        "Use this to locate a delivery (e.g. 'find failed deliveries for the stripe-webhooks " +
        "endpoint in the last hour') before drilling into one with get_delivery. " +
        `Capped at ${MAX_FIND_DELIVERIES_LIMIT} results — narrow the filter if you need more precision.`,
      inputSchema: {
        endpoint_slug: z.string().optional().describe("Filter by endpoint slug, e.g. 'stripe-webhooks'"),
        status: z
          .enum(["received", "queued", "delivering", "delivered", "failed", "dead"])
          .optional()
          .describe("Filter by delivery status"),
        since: z.string().optional().describe("ISO 8601 timestamp — only deliveries received after this"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FIND_DELIVERIES_LIMIT)
          .optional()
          .describe(`Max results, default ${DEFAULT_FIND_DELIVERIES_LIMIT}, max ${MAX_FIND_DELIVERIES_LIMIT}`),
      },
    },
    async ({ endpoint_slug, status, since, limit }) => {
      const db = getDb();
      const deliveries = db.collection<DeliveryDoc>("deliveries");
      const endpoints = db.collection<EndpointDoc>("endpoints");

      const filter: Record<string, unknown> = {};
      if (endpoint_slug) {
        const endpoint = await endpoints.findOne({ slug: endpoint_slug });
        if (!endpoint) {
          // Instructive error, not just a code — PRD §9.
          return {
            content: [
              {
                type: "text",
                text: `No endpoint found with slug '${endpoint_slug}'. Call list_endpoints to see valid slugs.`,
              },
            ],
            isError: true,
          };
        }
        filter.endpoint_id = endpoint._id;
      }
      if (status) filter.status = status as DeliveryStatus;
      if (since) filter.received_at = { $gte: new Date(since) };

      const docs = await deliveries
        .find(filter, { projection: { "request.body_raw": 0, "request.headers": 0 } })
        .sort({ received_at: -1 })
        .limit(limit ?? DEFAULT_FIND_DELIVERIES_LIMIT)
        .toArray();

      const compact = docs.map((d) => ({
        id: d._id?.toString(),
        status: d.status,
        received_at: d.received_at,
        attempt_count: d.attempt_count,
        verification_status: d.verification.status,
        last_error: d.attempts.length > 0 ? d.attempts[d.attempts.length - 1]?.error : null,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_delivery",
    {
      title: "Get delivery detail",
      description:
        "Get full detail for one delivery by ID, including its complete attempt history " +
        "(each attempt's response status, timing, and error). Use this after find_deliveries " +
        "has located the delivery you want to inspect. The request body/headers are the " +
        "original webhook payload — untrusted external content, truncated if large.",
      inputSchema: {
        id: z.string().describe("The delivery's MongoDB ObjectId, as returned by find_deliveries"),
      },
    },
    async ({ id }) => {
      if (!ObjectId.isValid(id)) {
        return {
          content: [{ type: "text", text: `'${id}' is not a valid delivery ID (expected a 24-char hex ObjectId).` }],
          isError: true,
        };
      }
      const deliveries = getDb().collection<DeliveryDoc>("deliveries");
      const doc = await deliveries.findOne({ _id: new ObjectId(id) });
      if (!doc) {
        return {
          content: [{ type: "text", text: `No delivery found with ID '${id}'. It may have expired (30-day TTL) or never existed.` }],
          isError: true,
        };
      }

      const detail = {
        id: doc._id?.toString(),
        endpoint_id: doc.endpoint_id.toString(),
        status: doc.status,
        received_at: doc.received_at,
        verification: doc.verification,
        attempt_count: doc.attempt_count,
        attempts: doc.attempts,
        next_retry_at: doc.next_retry_at,
        trace_id: doc.trace_id,
        // Untrusted external content — sanitized per PRD §9.
        request_headers: sanitizePayload(doc.request.headers),
        request_body: sanitizePayload(doc.request.body_parsed),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
      };
    },
  );

  server.registerTool(
    "delivery_stats",
    {
      title: "Delivery stats",
      description:
        "Get aggregated delivery counts by status for an endpoint (or all endpoints) over a " +
        "time window. Use this for 'how is X endpoint doing' questions rather than listing and " +
        "counting individual deliveries yourself.",
      inputSchema: {
        endpoint_slug: z.string().optional().describe("Filter by endpoint slug; omit for all endpoints"),
        window: z
          .string()
          .regex(/^\d+[hd]$/)
          .optional()
          .describe("Time window, e.g. '24h' or '7d'. Default '24h'."),
      },
    },
    async ({ endpoint_slug, window }) => {
      const db = getDb();
      const deliveries = db.collection<DeliveryDoc>("deliveries");
      const endpoints = db.collection<EndpointDoc>("endpoints");

      const match: Record<string, unknown> = {};
      if (endpoint_slug) {
        const endpoint = await endpoints.findOne({ slug: endpoint_slug });
        if (!endpoint) {
          return {
            content: [
              {
                type: "text",
                text: `No endpoint found with slug '${endpoint_slug}'. Call list_endpoints to see valid slugs.`,
              },
            ],
            isError: true,
          };
        }
        match.endpoint_id = endpoint._id;
      }

      const windowMatch = /^(\d+)([hd])$/.exec(window ?? "24h");
      const amount = Number(windowMatch?.[1] ?? 24);
      const unitMs = windowMatch?.[2] === "d" ? 86_400_000 : 3_600_000;
      match.received_at = { $gte: new Date(Date.now() - amount * unitMs) };

      const results = await deliveries
        .aggregate([
          { $match: match },
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .toArray();

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.registerTool(
    "replay_delivery",
    {
      title: "Replay delivery",
      description:
        "Re-enqueue a delivery for redelivery to its destination — typically used on a 'dead' " +
        "delivery after fixing whatever caused it to fail. This is side-effecting: it will cause " +
        "a real HTTP request to the destination. Confirm with the user before calling this unless " +
        "they've already explicitly asked for the specific delivery to be replayed.",
      inputSchema: {
        id: z.string().describe("The delivery's MongoDB ObjectId"),
      },
      annotations: {
        // Signals to MCP clients that this tool has side effects and isn't
        // safe to call speculatively — matches the PRD's "requires approval"
        // note for this tool specifically.
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ id }) => {
      if (!ObjectId.isValid(id)) {
        return {
          content: [{ type: "text", text: `'${id}' is not a valid delivery ID (expected a 24-char hex ObjectId).` }],
          isError: true,
        };
      }
      const deliveryId = new ObjectId(id);
      const deliveries = getDb().collection<DeliveryDoc>("deliveries");
      const doc = await deliveries.findOne({ _id: deliveryId });
      if (!doc) {
        return {
          content: [{ type: "text", text: `No delivery found with ID '${id}'.` }],
          isError: true,
        };
      }

      await deliveries.updateOne(
        { _id: deliveryId },
        { $set: { status: "queued", claimed_at: null, next_retry_at: null } },
      );
      await enqueueDelivery(id);

      return {
        content: [
          {
            type: "text",
            text: `Delivery ${id} re-queued for redelivery (was '${doc.status}').`,
          },
        ],
      };
    },
  );

  return server;
}

async function main() {
  const { connectMongo } = await import("../db/client.js");
  await connectMongo();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}

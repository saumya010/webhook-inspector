import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { trace, type Span } from "@opentelemetry/api";

/**
 * Must be initialized before any other module that should be traced is
 * imported — OTel's auto-instrumentation patches modules (like node:http)
 * at require/import time. See src/server.ts and src/worker.ts, which both
 * import this first.
 */
export function startTracing(): void {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "webhook-inspector";
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    ...(endpoint ? { traceExporter: new OTLPTraceExporter({ url: endpoint }) } : {}),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}

const tracer = trace.getTracer("webhook-inspector");

export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}

export function getCurrentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  return span.spanContext().traceId;
}

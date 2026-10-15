// The OTLP side of telemetry (issue #13, D223), like Argent's: the OpenTelemetry Logs SDK, one log
// record per event (body and event.name = the event's name, severity INFO, the sanitized
// attributes), batched and sent as OTLP/HTTP JSON with the app token as a Bearer header.
// The endpoint and headers are passed explicitly, and the user's own OTEL_* environment is
// cleared while the exporter and processor read their configuration (the SDK would merge
// OTEL_EXPORTER_OTLP_HEADERS into ours, sending someone's own collector credentials to us, and
// read certificate files synchronously), then put back for the agents and tools we start.
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

import type { Value } from "./events.ts";

export const SERVICE_NAME = "uncut";
/** Bounds the TCP connect too: a blackholed endpoint otherwise holds a socket for over a minute. */
export const EXPORT_TIMEOUT_MS = 1500;

export interface Sink {
  readonly emit: (name: string, attributes: Readonly<Record<string, Value>>) => void;
  /** Sends what is queued and stops; resolves within about EXPORT_TIMEOUT_MS + 250 ms, never rejects. */
  readonly shutdown: () => Promise<void>;
}

export interface SinkOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly version: string;
  /** Batch timing (tests send sooner). */
  readonly scheduledDelayMillis?: number;
  readonly maxExportBatchSize?: number;
}

/** Runs `make` with every OTEL_* variable removed from process.env, then restores them. */
export function withoutOtelEnv<T>(make: () => T, env: NodeJS.ProcessEnv = process.env): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    if (!key.startsWith("OTEL_")) continue;
    saved[key] = env[key];
    delete env[key];
  }
  try {
    return make();
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) env[key] = value;
  }
}

export function createOtlpSink(options: SinkOptions): Sink {
  const provider = withoutOtelEnv(() => {
    const exporter = new OTLPLogExporter({
      url: options.endpoint,
      headers: { Authorization: `Bearer ${options.token}` },
      // No compression: the default once OTEL_EXPORTER_OTLP_COMPRESSION is out of the way.
      timeoutMillis: EXPORT_TIMEOUT_MS,
      httpAgentOptions: { timeout: EXPORT_TIMEOUT_MS, keepAlive: true },
    });
    return new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME, "service.version": options.version }),
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          maxExportBatchSize: options.maxExportBatchSize ?? 20,
          scheduledDelayMillis: options.scheduledDelayMillis ?? 10_000,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
          maxQueueSize: 512,
        }),
      ],
    });
  });
  const logger = provider.getLogger(SERVICE_NAME);
  return {
    emit: (name, attributes) => {
      try {
        logger.emit({ body: name, eventName: name, severityNumber: SeverityNumber.INFO, severityText: "INFO", attributes: { ...attributes, "event.name": name } });
      } catch {}
    },
    shutdown: () =>
      Promise.race([
        provider.shutdown().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS + 250).unref()),
      ]),
  };
}

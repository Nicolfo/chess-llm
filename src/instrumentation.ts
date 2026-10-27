// Langfuse tracing via OpenTelemetry. Must be imported before anything that creates spans.
// Tracing is optional: without LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY the SDK is never
// started and the @langfuse/tracing calls in the app become no-ops.
//
// Configuration (environment variables, e.g. in .env):
//   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY   project API keys
//   LANGFUSE_BASE_URL                          https://cloud.langfuse.com (EU, default), https://us.cloud.langfuse.com, or self-hosted
//   LANGFUSE_TRACING_ENVIRONMENT               e.g. development / production
//   LANGFUSE_RELEASE                           defaults to the package.json version
import { createRequire } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

const { version } = createRequire(import.meta.url)('../package.json');

// Traces carry prompts and model answers, never request headers, but redact anything
// that looks like a provider API key in case one ends up in an error message.
const API_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,}|pk-lf-[A-Za-z0-9-]{8,})/g;

export const tracingEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

let sdk: NodeSDK | null = null;

if (tracingEnabled) {
  sdk = new NodeSDK({
    serviceName: 'chess-llm',
    spanProcessors: [
      new LangfuseSpanProcessor({
        release: process.env.LANGFUSE_RELEASE ?? version,
        mask: ({ data }) => (typeof data === 'string' ? data.replace(API_KEY_PATTERN, '***REDACTED***') : data),
      }),
    ],
  });
  sdk.start();
  console.log(`[langfuse] tracing enabled -> ${process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'}`);
} else {
  console.log('[langfuse] tracing disabled (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable)');
}

/** Flush pending spans and stop the exporter. Safe to call when tracing is disabled. */
export async function shutdownTracing() {
  await sdk?.shutdown();
}

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export function resolveOtlpEndpoint(environment: NodeJS.ProcessEnv): string {
  return environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces'
}

export function createTracingSdk(environment: NodeJS.ProcessEnv): NodeSDK {
  return new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'core-server' }),
    traceExporter: new OTLPTraceExporter({ url: resolveOtlpEndpoint(environment) }),
    instrumentations: [getNodeAutoInstrumentations()]
  })
}

resource "kubernetes_config_map" "core_server_config" {
  metadata {
    name      = "core-server-config"
    namespace = "core-server"
  }

  data = {
    ENVIRONMENT = "production"
    PORT        = "3333"

    CACHE_PREFIX = "ruguin:production"
    CACHE_DRIVER = "valkey"

    DOCS_USERNAME = var.docs_username

    # Full path, not a base URL: create-tracing-sdk.ts passes this straight through as
    # OTLPTraceExporter's `url` option, which is used as-is — the SDK only auto-appends
    # `/v1/traces` when `url` is left unset and it falls back to reading the env var itself.
    OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.honeycomb.io/v1/traces"
  }

  depends_on = [kubernetes_namespace.core_server]
}

resource "kubernetes_config_map" "core_server_dev_config" {
  metadata {
    name      = "core-server-config"
    namespace = "core-server-dev"
  }

  data = {
    ENVIRONMENT = "development"
    PORT        = "3333"

    # Same RDS/ElastiCache as production (see external-secrets.tf's core_server_dev_secrets for
    # the schema/prefix that actually isolates development's data) — CACHE_PREFIX here only
    # needs to differ from production's "ruguin:production" to avoid key collisions.
    CACHE_PREFIX = "ruguin:development"
    CACHE_DRIVER = "valkey"

    DOCS_USERNAME = var.docs_username

    OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.honeycomb.io/v1/traces"
  }

  depends_on = [kubernetes_namespace.core_server_dev]
}

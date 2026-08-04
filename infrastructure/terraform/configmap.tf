resource "kubernetes_config_map" "core_server_config" {
  metadata {
    name      = "core-server-config"
    namespace = "default"
  }

  data = {
    ENVIRONMENT = "production"
    PORT        = "3333"

    CACHE_PREFIX     = "ruguin:production"
    CACHE_DRIVER     = "valkey"
    CACHE_MASTER_URL = "redis://${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"

    DOCS_USERNAME = var.docs_username

    OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.honeycomb.io/v1/traces"
  }

  depends_on = [aws_elasticache_replication_group.core_server]
}

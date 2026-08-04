# Values land in raw Terraform state (Terraform's own limitation with kubernetes_secret) — a
# deliberate tradeoff, not an oversight: Decision 10 of the design spec chose sensitive Terraform
# variables over AWS Secrets Manager / an External Secrets Operator, since neither existed as
# infrastructure yet and this is a first deploy. Migrating to ESO later needs the current values
# revoked and replaced, since prior state versions retain them either way.
resource "kubernetes_secret" "core_server_secrets" {
  metadata {
    name      = "core-server-secrets"
    namespace = "core-server"
  }

  data = {
    DATABASE_URL  = "postgresql://${var.database_username}:${var.database_password}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
    DOCS_PASSWORD = var.docs_password
    # x-honeycomb-team is the only header Honeycomb's OTLP endpoint requires for authentication.
    OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=${var.honeycomb_api_key}"
  }

  depends_on = [aws_db_instance.core_server, kubernetes_namespace.core_server]
}

resource "kubernetes_secret" "ghcr_pull" {
  metadata {
    name      = "ghcr-pull-secret"
    namespace = "core-server"
  }

  type = "kubernetes.io/dockerconfigjson"

  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        "ghcr.io" = {
          username = var.ghcr_username
          password = var.ghcr_token
          auth     = base64encode("${var.ghcr_username}:${var.ghcr_token}")
        }
      }
    })
  }

  depends_on = [kubernetes_namespace.core_server]
}

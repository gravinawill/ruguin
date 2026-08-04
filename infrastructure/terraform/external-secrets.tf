resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
  }

  depends_on = [module.eks]
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = "2.5.0"
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }

  depends_on = [kubernetes_namespace.external_secrets]
}

resource "aws_secretsmanager_secret" "docs_password" {
  name = "ruguin/production/docs-password"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "honeycomb_api_key" {
  name = "ruguin/production/honeycomb-api-key"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "ghcr_token" {
  name = "ruguin/production/ghcr-token"
  tags = local.tags
}

module "external_secrets_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name = "${local.cluster_name}-external-secrets"

  permissions = {
    secrets_read = {
      sid     = "SecretsManagerRead"
      actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [
        aws_db_instance.core_server.master_user_secret[0].secret_arn,
        aws_secretsmanager_secret.docs_password.arn,
        aws_secretsmanager_secret.honeycomb_api_key.arn,
        aws_secretsmanager_secret.ghcr_token.arn
      ]
    }
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  tags = local.tags

  depends_on = [aws_db_instance.core_server]
}

resource "kubectl_manifest" "cluster_secret_store" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secrets-manager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = "external-secrets"
              }
            }
          }
        }
      }
    }
  })

  depends_on = [helm_release.external_secrets]
}

resource "kubectl_manifest" "core_server_secrets" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "core-server-secrets"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "core-server-secrets"
        template = {
          data = {
            DATABASE_URL               = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
            DOCS_PASSWORD              = "{{ .docsPassword }}"
            OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team={{ .honeycombApiKey }}"
          }
        }
      }
      data = [
        {
          secretKey = "databasePassword"
          remoteRef = {
            key      = aws_db_instance.core_server.master_user_secret[0].secret_arn
            property = "password"
          }
        },
        { secretKey = "docsPassword", remoteRef = { key = aws_secretsmanager_secret.docs_password.name } },
        { secretKey = "honeycombApiKey", remoteRef = { key = aws_secretsmanager_secret.honeycomb_api_key.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, aws_db_instance.core_server, kubernetes_namespace.core_server]
}

resource "kubectl_manifest" "ghcr_pull" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "ghcr-pull-secret"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "ghcr-pull-secret"
        template = {
          type = "kubernetes.io/dockerconfigjson"
          data = {
            ".dockerconfigjson" = "{\"auths\":{\"ghcr.io\":{\"username\":\"${var.ghcr_username}\",\"password\":\"{{ .ghcrToken }}\",\"auth\":\"{{ printf \"${var.ghcr_username}:%s\" .ghcrToken | b64enc }}\"}}}"
          }
        }
      }
      data = [
        { secretKey = "ghcrToken", remoteRef = { key = aws_secretsmanager_secret.ghcr_token.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, kubernetes_namespace.core_server]
}

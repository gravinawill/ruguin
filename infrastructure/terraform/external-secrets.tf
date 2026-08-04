# Operator runbook, ExternalSecret migration — two-step apply sequencing: if secrets.tf's old
# Kubernetes Secret resources (core_server_secrets, ghcr_pull) were ever actually applied to a real
# cluster before this migration lands, apply it in two separate `terraform apply` invocations —
# never one. First apply with only the secrets.tf deletion, and confirm via `kubectl get secret`
# that the old core-server-secrets/ghcr-pull-secret Kubernetes Secrets are gone; only then apply
# the new resources below (ClusterSecretStore + ExternalSecrets). Applying both in the same run
# races the old resource's destroy against the new ExternalSecret's create of a Secret with the
# identical name/namespace.
#
# Operator runbook, populating the Secrets Manager containers: Terraform only creates the three
# `aws_secretsmanager_secret` containers below — it never writes their values. Before each
# corresponding ExternalSecret can sync, an operator runs this once per secret:
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string "<value>"
# The three names: ruguin/production/docs-password, ruguin/production/honeycomb-api-key,
# ruguin/production/ghcr-token (also available via `terraform output` once applied). Until this
# runs, the corresponding ExternalSecret stays in SecretSyncedError — expected behavior, not a bug.
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

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.external_secrets_irsa.arn
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

# Known gap, deliberately deferred: AWS rotates the RDS-managed master password
# (manage_master_user_password, data.tf) every 7 days by default, but core-server's pods consume
# DATABASE_URL via envFrom.secretRef — an env var set once at pod start, never hot-reloaded — so a
# running pod keeps using the stale password after each rotation until it's manually restarted.
# Closing this needs a conscious choice (a reloader controller, reading the secret at runtime
# instead of envFrom, or disabling auto-rotation); tracked as a known risk, not a silent gap.
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

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

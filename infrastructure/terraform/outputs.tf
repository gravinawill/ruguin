output "cluster_name" {
  description = "EKS cluster name — used with `aws eks update-kubeconfig --name <this>` to get kubectl access."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "database_endpoint" {
  description = "RDS PostgreSQL connection endpoint (host:port)."
  value       = aws_db_instance.core_server.endpoint
}

output "cache_endpoint" {
  description = "ElastiCache Valkey primary endpoint address."
  value       = aws_elasticache_replication_group.core_server.primary_endpoint_address
}

output "argocd_namespace" {
  description = "Namespace ArgoCD is installed in — `kubectl -n <this> get pods` to check it's healthy."
  value       = kubernetes_namespace.argocd.metadata[0].name
}

output "docs_password_secret_name" {
  description = "Secrets Manager secret name for the /docs Basic Auth password — populate with `aws secretsmanager put-secret-value --secret-id <this> --secret-string \"<value>\"`."
  value       = aws_secretsmanager_secret.docs_password.name
}

output "honeycomb_api_key_secret_name" {
  description = "Secrets Manager secret name for the Honeycomb API key — populate with `aws secretsmanager put-secret-value --secret-id <this> --secret-string \"<value>\"`."
  value       = aws_secretsmanager_secret.honeycomb_api_key.name
}

output "ghcr_token_secret_name" {
  description = "Secrets Manager secret name for the GHCR pull token — populate with `aws secretsmanager put-secret-value --secret-id <this> --secret-string \"<value>\"`."
  value       = aws_secretsmanager_secret.ghcr_token.name
}

output "external_secrets_irsa_role_arn" {
  description = "IAM role ARN the External Secrets Operator ServiceAccount assumes via IRSA."
  value       = module.external_secrets_irsa.arn
}

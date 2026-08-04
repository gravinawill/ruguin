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

variable "aws_region" {
  description = "AWS region for every resource this module provisions."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name prefixed onto every resource this module creates."
  type        = string
  default     = "ruguin"
}

variable "environment" {
  description = "Deployment environment name, used in resource naming and tags."
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. /16 split into /20s across public, private, database and elasticache subnets."
  type        = string
  default     = "10.0.0.0/16"
}

variable "kubernetes_version" {
  description = "EKS control plane Kubernetes version."
  type        = string
  default     = "1.34"
}

variable "eks_public_access_cidrs" {
  description = "CIDR blocks allowed to reach the EKS public API endpoint (the network Terraform itself runs from). No default on purpose — the module's own default is 0.0.0.0/0, and this variable exists specifically so applying without an explicit value fails instead of silently allowing every IPv4 address."
  type        = list(string)
}

variable "database_username" {
  description = "Master username for the RDS PostgreSQL instance."
  type        = string
  default     = "ruguin"
}

variable "ghcr_username" {
  description = "GitHub username that owns the GHCR Personal Access Token below — used to build the imagePullSecret core-server's Deployment references."
  type        = string
}

variable "docs_username" {
  description = "Basic Auth username for core-server's /docs endpoint in production."
  type        = string
  default     = "docs"
}

variable "argocd_repo_url" {
  description = "Git URL ArgoCD watches for infrastructure/k8s/core-server manifests."
  type        = string
  default     = "https://github.com/gravinawill/ruguin.git"
}

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

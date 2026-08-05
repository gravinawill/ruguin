data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.6"

  name = "${var.project_name}-vpc"
  cidr = var.vpc_cidr

  # Two AZs: the minimum EKS accepts. A single NAT Gateway (not one per AZ) trades an AZ-level
  # single point of failure for outbound traffic for roughly half the monthly NAT cost — an
  # acceptable trade for a cluster with no production traffic yet (see the design doc's Risks).
  azs              = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets   = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 2)]
  database_subnets = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 4)]

  enable_nat_gateway     = true
  single_nat_gateway     = true
  one_nat_gateway_per_az = false

  create_database_subnet_group    = true
  create_elasticache_subnet_group = true
  elasticache_subnets             = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 6)]

  enable_dns_hostnames = true
  enable_dns_support   = true

  # Required by the EKS module so it can auto-discover subnets to place Fargate ENIs and the
  # AWS Load Balancer Controller can auto-discover which subnets to place load balancers in.
  public_subnet_tags = {
    "kubernetes.io/role/elb"                      = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"             = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }

  tags = local.tags
}

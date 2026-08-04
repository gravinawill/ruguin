module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = local.cluster_name
  kubernetes_version = var.kubernetes_version

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  # Both true: Terraform itself needs the public endpoint to reach the cluster when applying from
  # outside the VPC (this environment has no VPN/bastion into it), and Fargate pods reach the API
  # over the private endpoint without traversing the NAT Gateway.
  endpoint_public_access  = true
  endpoint_private_access = true

  # No node group: every workload runs on Fargate. kube-system needs its own profile so CoreDNS
  # (which the cluster creates automatically) has somewhere to schedule — without it, DNS
  # resolution inside the cluster never comes up.
  fargate_profiles = {
    kube_system = {
      name = "kube-system"
      selectors = [
        { namespace = "kube-system" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
    default = {
      name = "default"
      selectors = [
        { namespace = "default" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
  }

  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = true

  tags = local.tags
}

module "load_balancer_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name = "${local.cluster_name}-lb-controller"

  attach_load_balancer_controller_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = local.tags
}

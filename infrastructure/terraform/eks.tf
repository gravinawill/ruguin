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

  # No node group: every workload runs on Fargate, so every namespace that runs pods needs a profile
  # listed here. For kube-system the profile is necessary but not sufficient — see `addons` below for
  # what actually makes CoreDNS schedulable.
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
    argocd = {
      name = "argocd"
      selectors = [
        { namespace = "argocd" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
  }

  # EKS creates the CoreDNS Deployment annotated `eks.amazonaws.com/compute-type: ec2`, pinning it to
  # EC2 nodes this cluster doesn't have — the kube-system Fargate profile alone leaves it Pending
  # forever and nothing in the cluster resolves DNS. Managing the addon here is what overrides that.
  addons = {
    coredns = {
      configuration_values = jsonencode({
        computeType = "Fargate"
      })
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

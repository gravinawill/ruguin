# Fargate pods have no EC2 instance for the legacy in-tree load balancer provider to target — the
# AWS Load Balancer Controller is what core-server's Service (infrastructure/k8s/core-server/
# service.yaml, applied by ArgoCD, not Terraform) actually needs to get a working NLB. See the
# design doc's decision 6 for why this isn't optional once Fargate is the compute choice.
resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "3.5.0"
  namespace  = "kube-system"

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "region"
    value = var.aws_region
  }

  set {
    name  = "vpcId"
    value = module.vpc.vpc_id
  }

  set {
    name  = "serviceAccount.create"
    value = "true"
  }

  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.load_balancer_controller_irsa.arn
  }

  depends_on = [module.eks]
}

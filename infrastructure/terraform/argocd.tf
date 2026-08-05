resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
  }

  depends_on = [module.eks]
}

# core-server's own workload namespace, kept out of `default` so RBAC/NetworkPolicy/quota can
# scope to it later without touching anything else running in the cluster.
resource "kubernetes_namespace" "core_server" {
  metadata {
    name = "core-server"
  }

  depends_on = [module.eks]
}

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = "10.2.2"
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  depends_on = [kubernetes_namespace.argocd]
}

# The Application CRD only exists once the Helm release above has installed it — kubectl_manifest
# applies server-side without validating against that CRD's schema at plan time, so it doesn't hit
# the chicken-and-egg problem hashicorp/kubernetes's kubernetes_manifest would (see versions.tf).
# From here on, changes to infrastructure/k8s/core-server/ sync on their own; only a change to
# this Application definition itself (repo, path, project) goes through Terraform again.
resource "kubectl_manifest" "core_server_application" {
  yaml_body = yamlencode({
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "core-server"
      namespace = kubernetes_namespace.argocd.metadata[0].name
    }
    spec = {
      project = "default"
      source = {
        repoURL = var.argocd_repo_url
        # The image is pinned to a digest by release-image.yml's "promote" job (only runs on
        # push to master, after a build is scanned and signed) — HEAD stays correct to track
        # here because this directory only changes via that deliberate commit, not implicitly.
        targetRevision = "HEAD"
        path           = "infrastructure/k8s/core-server/overlays/production"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "core-server"
      }
      syncPolicy = {
        automated = {
          prune    = true
          selfHeal = true
        }
        # Namespace is Terraform-managed (kubernetes_namespace.core_server above), matching how
        # the argocd namespace itself is created — ArgoCD doesn't also try to own its lifecycle.
        syncOptions = ["CreateNamespace=false"]
      }
    }
  })

  depends_on = [helm_release.argocd, kubernetes_namespace.core_server]
}

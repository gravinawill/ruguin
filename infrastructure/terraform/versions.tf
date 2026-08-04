terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
    # hashicorp/kubernetes's own kubernetes_manifest resource validates against the target CRD's
    # schema at plan time — which doesn't exist yet on a first apply, since the ArgoCD Helm release
    # in this same module is what installs it. alekc/kubectl's kubectl_manifest resource applies
    # server-side without that plan-time validation, sidestepping the chicken-and-egg problem.
    kubectl = {
      source  = "alekc/kubectl"
      version = "~> 2.4"
    }
  }

  # Bucket and table names come from bootstrap/'s outputs (Task 1) — filled in once that module
  # has been applied. Terraform's backend block can't reference variables or another module's
  # output, so these three values are the one place in this codebase where a real value has to be
  # typed in by hand after bootstrap/ runs, not left as a variable.
  backend "s3" {
    bucket         = "REPLACE_WITH_BOOTSTRAP_STATE_BUCKET_NAME_OUTPUT"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ruguin-terraform-lock"
    encrypt        = true
  }
}

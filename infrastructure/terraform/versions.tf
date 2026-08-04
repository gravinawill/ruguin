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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Bucket and table names come from bootstrap/'s outputs (Task 1) — filled in once that module
  # has been applied. Terraform's backend block can't reference variables or another module's
  # output, so these three values are the one place in this codebase where a real value has to be
  # typed in by hand after bootstrap/ runs, not left as a variable.
  #
  # Operator runbook: `cd infrastructure/terraform/bootstrap && terraform apply`, note its
  # `state_bucket_name` and `lock_table_name` outputs, then replace the two placeholders below
  # (bucket and dynamodb_table) with those exact values before ever running `terraform init`
  # against this main module for real. `-backend=false` (used throughout this repo's validation)
  # never reads this block, so a stale placeholder here doesn't fail CI — only a real init would.
  #
  # Operator runbook, ExternalSecret migration: if secrets.tf's old Kubernetes Secret resources
  # (core_server_secrets, ghcr_pull) were ever actually applied to a real cluster before the
  # ExternalSecret migration lands, apply it in two separate `terraform apply` invocations —
  # never one. First apply with only the secrets.tf deletion, and confirm via `kubectl get secret`
  # that the old core-server-secrets/ghcr-pull-secret Kubernetes Secrets are gone; only then apply
  # the new external-secrets.tf resources (ClusterSecretStore + ExternalSecrets). Applying both in
  # the same run races the old resource's destroy against the new ExternalSecret's create of a
  # Secret with the identical name/namespace.
  backend "s3" {
    bucket         = "REPLACE_WITH_BOOTSTRAP_STATE_BUCKET_NAME_OUTPUT"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ruguin-terraform-lock"
    encrypt        = true
  }
}

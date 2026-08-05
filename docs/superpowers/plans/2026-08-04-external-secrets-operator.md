# External Secrets Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four genuinely-sensitive production secrets (`database_password`, `docs_password`, `honeycomb_api_key`, `ghcr_token`) out of the Terraform state for real, using AWS Secrets Manager + the External Secrets Operator (ESO) on the existing EKS cluster.

**Architecture:** Terraform creates only *containers* (or, for the RDS master password, lets AWS manage the value entirely) — it never writes a secret value into its own state. The External Secrets Operator, installed via `helm_release` (same pattern as the existing ArgoCD install in `argocd.tf`), reads those containers through a `ClusterSecretStore` authenticated via IRSA, and materializes them into the same-named Kubernetes Secrets (`core-server-secrets`, `ghcr-pull-secret`) that `deployment.yaml` already references — so nothing downstream of the Secret objects changes.

**Tech Stack:** Terraform (`hashicorp/aws` `~> 6.0`, `hashicorp/kubernetes` `~> 2.35`, `hashicorp/helm` `~> 2.16`, `alekc/kubectl` `~> 2.4` — all already configured in `infrastructure/terraform/providers.tf`), `terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts` `~> 6.0` (already vendored via `load_balancer_controller_irsa` in `eks.tf`), External Secrets Operator Helm chart from `https://charts.external-secrets.io`.

## Global Constraints

- Only `database_password`, `docs_password`, `honeycomb_api_key`, `ghcr_token` leave Terraform state. `ghcr_username` stays a plain Terraform variable — it is not a secret itself.
- `database_password` uses RDS's native `manage_master_user_password = true` — never a manually-populated Secrets Manager container. `password` and `manage_master_user_password` are mutually exclusive on `aws_db_instance` — remove `password` when adding `manage_master_user_password`.
- The other three (`docs_password`, `honeycomb_api_key`, `ghcr_token`) each get an `aws_secretsmanager_secret` container (name + tags only) created by Terraform. Terraform never manages an `aws_secretsmanager_secret_version` for them — the value is written later, out of band, by a human operator via `aws secretsmanager put-secret-value`.
- Secret naming: `ruguin/production/docs-password`, `ruguin/production/honeycomb-api-key`, `ruguin/production/ghcr-token`.
- ESO installs via `helm_release`, chart `external-secrets` from repository `https://charts.external-secrets.io`, in a new `external-secrets` namespace — same shape as the existing `helm_release.argocd` in `argocd.tf`.
- IRSA for ESO reuses `module.eks.oidc_provider_arn` (already used by `load_balancer_controller_irsa` in `eks.tf`) via the `terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts` module, version `~> 6.0`. Custom policy grants go through that module's `permissions` input (a map of statement objects) — **not** `role_policy_arns`, which this module does not have (confirmed by reading the vendored module's own `variables.tf`).
- `ClusterSecretStore`, not `SecretStore` — cluster-scoped, since other product services will need the same Secrets Manager access later.
- `ClusterSecretStore` and `ExternalSecret` are created via `kubectl_manifest` (the `alekc/kubectl` provider), never `kubernetes_manifest` — both CRDs (`ClusterSecretStore`, `ExternalSecret`) only exist after the ESO Helm release installs them, and `kubectl_manifest` applies server-side without validating against the CRD schema at plan time, avoiding the chicken-and-egg problem `kubernetes_manifest` would hit (same reasoning already documented in `versions.tf` for the ArgoCD `Application` CRD).
- The resulting Kubernetes Secret names stay exactly `core-server-secrets` and `ghcr-pull-secret` — `deployment.yaml` is not touched by this plan.
- `infrastructure/terraform/secrets.tf` is deleted entirely.
- The four now-unreferenced variable declarations (`database_password`, `docs_password`, `honeycomb_api_key`, `ghcr_token`) are removed from `infrastructure/terraform/variables.tf`.
- No real `terraform apply` runs against AWS in this plan (no credentials, and the remote backend in `versions.tf` is still an unfilled placeholder from an earlier wave) — every task's verification is `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`, and `tflint`, matching how every prior Terraform change in this repo was verified this session.

---

## File Structure

- **Modify `infrastructure/terraform/data.tf`** — swap `aws_db_instance.core_server`'s `password` argument for `manage_master_user_password = true`.
- **Create `infrastructure/terraform/external-secrets.tf`** — everything new in this plan: the `external-secrets` namespace, the ESO `helm_release`, the three `aws_secretsmanager_secret` containers, the IRSA module, the `ClusterSecretStore`, and the two `ExternalSecret` resources (`core-server-secrets`, `ghcr-pull-secret`). One file, matching how `argocd.tf` already concentrates everything for that operator.
- **Delete `infrastructure/terraform/secrets.tf`** — its two `kubernetes_secret` resources are fully replaced by the `ExternalSecret` resources in `external-secrets.tf`.
- **Modify `infrastructure/terraform/variables.tf`** — remove the four variable declarations that no longer have any reference anywhere in the module.

## Verification commands used across all tasks

- **Format:** `terraform fmt -check -diff infrastructure/terraform` (run from the repo root) — must produce no output.
- **Init + validate:** from `infrastructure/terraform`, `terraform init -backend=false -input=false`, then `terraform validate` — must print `Success! The configuration is valid.` Run `rm -rf .terraform` afterward each time — it is git-ignored scratch, never commit it (confirm with `git status --short infrastructure/terraform` before committing).
- **Lint:** `tflint --chdir=infrastructure/terraform` — must produce no output.
- **Dead-reference check:** `grep -rn "var\.database_password\|var\.docs_password\|var\.honeycomb_api_key\|var\.ghcr_token" infrastructure/terraform` — must return nothing once Task 3 is done (confirms no leftover reference to the removed variables).

---

### Task 1: RDS-managed master password

**Files:**
- Modify: `infrastructure/terraform/data.tf`

**Interfaces:**
- Produces: `aws_db_instance.core_server.master_user_secret[0].secret_arn` (an AWS-computed attribute, only resolvable after this resource is actually applied) — Task 2 and Task 3 reference this exact expression in the IRSA policy and the `ExternalSecret` for `core-server-secrets`, and both must declare `depends_on = [aws_db_instance.core_server]` because of it.

- [ ] **Step 1: Swap `password` for `manage_master_user_password` in `data.tf`**

Find this exact block in `infrastructure/terraform/data.tf` (inside `resource "aws_db_instance" "core_server"`):

```hcl
  db_name  = "ruguin"
  username = var.database_username
  password = var.database_password
  port     = 5432
```

Replace it with:

```hcl
  db_name  = "ruguin"
  username = var.database_username
  port     = 5432

  # AWS manages this secret end to end (creation, storage, rotation) — Terraform never sees the
  # value, so it never enters state. Mutually exclusive with a `password` argument.
  manage_master_user_password = true
```

- [ ] **Step 2: Format, init, validate, lint**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
terraform validate
tflint --chdir=.
rm -rf .terraform
cd ../..
git status --short infrastructure/terraform
```

Expected: `fmt` prints nothing, `validate` prints `Success! The configuration is valid.`, `tflint` prints nothing, and `git status` shows no `.terraform` directory (confirms the cleanup ran).

- [ ] **Step 3: Confirm no other reference to `var.database_password` remains in this file**

```bash
grep -n "var.database_password" infrastructure/terraform/data.tf
```

Expected: no output (the only reference was the line removed in Step 1). The variable declaration itself in `variables.tf` is removed later, in Task 3 — do not touch `variables.tf` in this task, since `docs_password`/`honeycomb_api_key`/`ghcr_token` still reference their own variables until Task 2/3 replace those usages too.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/terraform/data.tf
git commit -m "feat(infra): let RDS manage its own master password via Secrets Manager"
```

---

### Task 2: External Secrets Operator install + Secrets Manager containers + IRSA

**Files:**
- Create: `infrastructure/terraform/external-secrets.tf`

**Interfaces:**
- Consumes: `aws_db_instance.core_server.master_user_secret[0].secret_arn` (from Task 1).
- Produces: `kubernetes_namespace.external_secrets`, `helm_release.external_secrets`, `aws_secretsmanager_secret.docs_password` / `.honeycomb_api_key` / `.ghcr_token` (each exposing `.name` and `.arn`), `module.external_secrets_irsa` — Task 3 adds the `ClusterSecretStore`/`ExternalSecret` resources to this same file and references `helm_release.external_secrets` (for its own `depends_on`) and the three `aws_secretsmanager_secret.*.name` values (for `ExternalSecret`'s `remoteRef.key`).

- [ ] **Step 1: Create `infrastructure/terraform/external-secrets.tf` with the namespace, Helm release, secret containers, and IRSA role**

```hcl
resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
  }

  depends_on = [module.eks]
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = "2.5.0"
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }

  depends_on = [kubernetes_namespace.external_secrets]
}

resource "aws_secretsmanager_secret" "docs_password" {
  name = "ruguin/production/docs-password"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "honeycomb_api_key" {
  name = "ruguin/production/honeycomb-api-key"
  tags = local.tags
}

resource "aws_secretsmanager_secret" "ghcr_token" {
  name = "ruguin/production/ghcr-token"
  tags = local.tags
}

module "external_secrets_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name = "${local.cluster_name}-external-secrets"

  permissions = {
    secrets_read = {
      sid     = "SecretsManagerRead"
      actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = [
        aws_db_instance.core_server.master_user_secret[0].secret_arn,
        aws_secretsmanager_secret.docs_password.arn,
        aws_secretsmanager_secret.honeycomb_api_key.arn,
        aws_secretsmanager_secret.ghcr_token.arn
      ]
    }
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  tags = local.tags

  depends_on = [aws_db_instance.core_server]
}
```

- [ ] **Step 2: Format, init, validate, lint**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
terraform validate
tflint --chdir=.
rm -rf .terraform
cd ../..
git status --short infrastructure/terraform
```

Expected: same as Task 1 Step 2 — `fmt` silent, `validate` succeeds, `tflint` silent, no stray `.terraform` directory left in git status.

- [ ] **Step 3: Confirm the IRSA policy references all four secrets by their real resource addresses, not string literals**

```bash
grep -n "master_user_secret\[0\].secret_arn\|aws_secretsmanager_secret\.\(docs_password\|honeycomb_api_key\|ghcr_token\)\.arn" infrastructure/terraform/external-secrets.tf
```

Expected: 4 matches inside the `permissions.secrets_read.resources` list — confirms the IAM policy is wired to the actual resources (via Terraform references), not to hand-typed ARN strings that could drift.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/terraform/external-secrets.tf
git commit -m "feat(infra): install External Secrets Operator with IRSA and Secrets Manager containers"
```

---

### Task 3: `ClusterSecretStore` + `ExternalSecret` resources, remove `secrets.tf`, clean up dead variables

**Files:**
- Modify: `infrastructure/terraform/external-secrets.tf` (append `ClusterSecretStore` + 2x `ExternalSecret`)
- Delete: `infrastructure/terraform/secrets.tf`
- Modify: `infrastructure/terraform/variables.tf` (remove 4 unused variable declarations)

**Interfaces:**
- Consumes: `helm_release.external_secrets`, `aws_secretsmanager_secret.docs_password` / `.honeycomb_api_key` / `.ghcr_token`, `aws_db_instance.core_server.master_user_secret[0].secret_arn` (all from Task 1/2). `kubernetes_namespace.core_server` (already exists, defined in `argocd.tf`).
- Produces: two Kubernetes Secrets named `core-server-secrets` and `ghcr-pull-secret` in the `core-server` namespace, populated and kept in sync by ESO — the terminal deliverable of this plan. Nothing downstream (`deployment.yaml`) changes, since these names already match what it references today.

- [ ] **Step 1: Append the `ClusterSecretStore` to `infrastructure/terraform/external-secrets.tf`**

Add this after the `module "external_secrets_irsa"` block (end of the file from Task 2):

```hcl
resource "kubectl_manifest" "cluster_secret_store" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secrets-manager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = "external-secrets"
              }
            }
          }
        }
      }
    }
  })

  depends_on = [helm_release.external_secrets]
}
```

- [ ] **Step 2: Append the two `ExternalSecret` resources**

```hcl
resource "kubectl_manifest" "core_server_secrets" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "core-server-secrets"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "core-server-secrets"
        template = {
          data = {
            DATABASE_URL               = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
            DOCS_PASSWORD              = "{{ .docsPassword }}"
            OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team={{ .honeycombApiKey }}"
          }
        }
      }
      data = [
        {
          secretKey = "databasePassword"
          remoteRef = {
            key      = aws_db_instance.core_server.master_user_secret[0].secret_arn
            property = "password"
          }
        },
        { secretKey = "docsPassword", remoteRef = { key = aws_secretsmanager_secret.docs_password.name } },
        { secretKey = "honeycombApiKey", remoteRef = { key = aws_secretsmanager_secret.honeycomb_api_key.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, aws_db_instance.core_server, kubernetes_namespace.core_server]
}

resource "kubectl_manifest" "ghcr_pull" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "ghcr-pull-secret"
      namespace = "core-server"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "ghcr-pull-secret"
        template = {
          type = "kubernetes.io/dockerconfigjson"
          data = {
            ".dockerconfigjson" = "{\"auths\":{\"ghcr.io\":{\"username\":\"${var.ghcr_username}\",\"password\":\"{{ .ghcrToken }}\",\"auth\":\"{{ printf \"${var.ghcr_username}:%s\" .ghcrToken | b64enc }}\"}}}"
          }
        }
      }
      data = [
        { secretKey = "ghcrToken", remoteRef = { key = aws_secretsmanager_secret.ghcr_token.name } }
      ]
    }
  })

  depends_on = [kubectl_manifest.cluster_secret_store, kubernetes_namespace.core_server]
}
```

- [ ] **Step 3: Delete `infrastructure/terraform/secrets.tf`**

```bash
git rm infrastructure/terraform/secrets.tf
```

- [ ] **Step 4: Remove the four now-unreferenced variables from `infrastructure/terraform/variables.tf`**

Find and remove these four blocks (in the order they currently appear in the file):

```hcl
variable "database_password" {
  description = "Master password for the RDS PostgreSQL instance."
  type        = string
  sensitive   = true
}
```

```hcl
variable "ghcr_token" {
  description = "GHCR Personal Access Token with read:packages scope, used as the imagePullSecret for pulling ghcr.io/gravinawill/ruguin/core-server."
  type        = string
  sensitive   = true
}
```

```hcl
variable "honeycomb_api_key" {
  description = "Honeycomb API key with send-events permission, used as OTEL_EXPORTER_OTLP_HEADERS' x-honeycomb-team value."
  type        = string
  sensitive   = true
}
```

```hcl
variable "docs_password" {
  description = "Basic Auth password for core-server's /docs endpoint in production."
  type        = string
  sensitive   = true
}
```

Leave `database_username`, `ghcr_username`, and `docs_username` in place — they are still referenced (by `data.tf`, `external-secrets.tf`, and `configmap.tf` respectively).

- [ ] **Step 5: Format, init, validate, lint**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
terraform validate
tflint --chdir=.
rm -rf .terraform
cd ../..
git status --short infrastructure/terraform
```

Expected: same as prior tasks — clean `fmt`, `Success! The configuration is valid.` from `validate`, silent `tflint`, no stray `.terraform`.

- [ ] **Step 6: Confirm no dead references remain anywhere in the module**

```bash
grep -rn "var\.database_password\|var\.docs_password\|var\.honeycomb_api_key\|var\.ghcr_token" infrastructure/terraform
```

Expected: no output. If anything matches, find and fix that reference before proceeding — it means either Task 2/3's `ExternalSecret` template wiring or this variable cleanup missed a spot.

- [ ] **Step 7: Confirm `secrets.tf` is gone and the two `kubernetes_secret` resource types no longer appear anywhere in the module**

```bash
ls infrastructure/terraform/secrets.tf 2>&1
grep -rn "kubernetes_secret" infrastructure/terraform/*.tf
```

Expected: the `ls` fails with "No such file or directory" (confirms deletion), and the `grep` returns no output (confirms no resource of type `kubernetes_secret` remains anywhere in the module — both `core_server_secrets` and `ghcr_pull` are now `kubectl_manifest`/`ExternalSecret`, not `kubernetes_secret`).

- [ ] **Step 8: Commit**

`git rm` in Step 3 already staged `secrets.tf`'s deletion — this just adds the other two changed files and commits everything together:

```bash
git add infrastructure/terraform/external-secrets.tf infrastructure/terraform/variables.tf
git commit -m "feat(infra): sync core-server secrets from AWS Secrets Manager via ExternalSecret"
```

---

## Final Verification

After all three tasks:

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
terraform validate
tflint --chdir=.
rm -rf .terraform
cd ../..
git status --short infrastructure/terraform
grep -rn "var\.database_password\|var\.docs_password\|var\.honeycomb_api_key\|var\.ghcr_token\|kubernetes_secret" infrastructure/terraform/*.tf
ls infrastructure/terraform/secrets.tf 2>&1
```

Expected: `fmt`/`validate`/`tflint` all clean, no stray `.terraform` in git status, the `grep` for dead variables and `kubernetes_secret` resources returns nothing, and `ls secrets.tf` reports the file doesn't exist.

**Known limitation, not a failure:** none of this can be verified with a real `terraform plan`/`apply` in this environment (no AWS credentials, and the S3 backend in `versions.tf` still has its bootstrap placeholder unfilled from an earlier wave) — `validate` confirms the configuration is internally well-formed, not that a real `apply` would succeed against AWS. Two real-world risks the spec's Riscos section already names and this plan cannot close on its own: (1) the exact `external-secrets` Helm chart version and the ServiceAccount name it creates should be confirmed against the real chart before a real `apply`; (2) if `secrets.tf`'s `kubernetes_secret` resources were ever actually applied to a real cluster before this plan runs there, the rollout must apply the `secrets.tf` deletion and the new `external-secrets.tf` resources in two separate `terraform apply` invocations (destroy old Secrets first, confirm they're gone, then create the new ones) — never in the same apply — to avoid a create/destroy race on the same Kubernetes Secret name. Document this two-step sequence in whatever runbook governs a real rollout of this module (the same place `versions.tf`'s backend-bootstrap runbook note lives).

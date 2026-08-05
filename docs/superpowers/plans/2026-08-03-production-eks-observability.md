# Production EKS + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terraform code for a real EKS cluster (Fargate), managed Postgres/Valkey, GitOps via
ArgoCD, and core-server's telemetry shipping to Honeycomb — reviewed and validated, not applied.

**Architecture:** A `bootstrap/` Terraform module (local state) provisions the S3+DynamoDB backend
the main module needs. The main module (`infrastructure/terraform/`) provisions VPC → EKS
(Fargate) → AWS Load Balancer Controller → RDS/ElastiCache → Kubernetes secrets/config → ArgoCD,
which then syncs `infrastructure/k8s/core-server/` (plain Kubernetes manifests, not
Terraform-managed) on its own.

**Tech Stack:** Terraform 1.15+, `terraform-aws-modules/vpc/aws` ~> 6.6,
`terraform-aws-modules/eks/aws` ~> 21.0, `terraform-aws-modules/iam/aws` ~> 6.0,
`hashicorp/aws` ~> 6.0, `hashicorp/kubernetes` ~> 2.35, `hashicorp/helm` ~> 2.16,
`alekc/kubectl` ~> 2.4, ArgoCD (Helm chart `argo-cd` 10.2.2), AWS Load Balancer Controller
(Helm chart 3.5.0).

## Global Constraints

- **This environment has no `aws` CLI and no AWS credentials.** No task applies anything. Every
  task's verification is `terraform fmt -check`, `terraform init -backend=false`,
  `terraform validate`, and `tflint` — all confirmed to work without credentials in this exact
  environment before this plan was written. `terraform` (1.15.8) and `tflint` (0.64.0) were
  installed via `brew install hashicorp/tap/terraform` and
  `brew install terraform-linters/tap/tflint` — a fresh environment needs the same two installs
  before starting Task 1.
- English in all code, comments, and commit messages.
- GHCR stays the image registry — no ECR, no image mirroring (see design doc decision 1).
- Compute is Fargate only — no EC2 node group, ever, in this plan (decision 2).
- The AWS Load Balancer Controller is mandatory, not optional, once Fargate is the compute choice
  — verified against AWS's own docs (decision 6). Exposure stays `Service: LoadBalancer` (NLB),
  not `Ingress`.
- Secrets are Terraform `sensitive` variables materialized as `kubernetes_secret` resources — no
  AWS Secrets Manager, no External Secrets Operator (decision 10).
- Every task's Terraform files, once written, must leave `infrastructure/terraform/` in a state
  where `terraform init -backend=false && terraform validate` succeeds standalone — this was
  verified task-by-task while writing this plan (each task's file set was copied into a scratch
  directory and validated in isolation before being written into this document).

---

### Task 1: Terraform bootstrap — S3 + DynamoDB state backend

**Files:**
- Create: `infrastructure/terraform/bootstrap/main.tf`
- Create: `infrastructure/terraform/bootstrap/variables.tf`
- Create: `infrastructure/terraform/bootstrap/outputs.tf`

**Interfaces:**
- Produces: an S3 bucket and DynamoDB table whose names (from `outputs.tf`) Task 2 needs to fill
  into the main module's `backend "s3"` block — this is the one value in this whole plan that
  can't be known until a human actually applies this task with real AWS credentials.

- [ ] **Step 1: Write `infrastructure/terraform/bootstrap/main.tf`**

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}
```

- [ ] **Step 2: Write `infrastructure/terraform/bootstrap/variables.tf`**

```hcl
variable "aws_region" {
  description = "AWS region for the Terraform state bucket and lock table."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for Terraform remote state. Must be set explicitly — S3 bucket names are global across all AWS accounts."
  type        = string
}

variable "lock_table_name" {
  description = "DynamoDB table name for Terraform state locking."
  type        = string
  default     = "ruguin-terraform-lock"
}
```

- [ ] **Step 3: Write `infrastructure/terraform/bootstrap/outputs.tf`**

```hcl
output "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform remote state — use this in the main module's backend configuration."
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "Name of the DynamoDB table used for state locking — use this in the main module's backend configuration."
  value       = aws_dynamodb_table.terraform_lock.name
}
```

- [ ] **Step 4: Format, initialize, and validate**

```bash
cd infrastructure/terraform/bootstrap
terraform fmt -check -diff .
terraform init -backend=false
terraform validate
```

Expected: `terraform fmt` prints nothing (already formatted); `terraform init` reports "Terraform
has been successfully initialized!"; `terraform validate` prints "Success! The configuration is
valid."

- [ ] **Step 5: Clean up the local init artifacts before committing**

```bash
rm -rf infrastructure/terraform/bootstrap/.terraform
```

`terraform init` writes a `.terraform/` directory (downloaded provider binaries) and a
`.terraform.lock.hcl` file. Remove `.terraform/` (never committed — matches every other Terraform
setup); keep `.terraform.lock.hcl` if it was created, since that one **is** meant to be committed
(pins exact provider versions).

- [ ] **Step 6: Commit**

```bash
git add infrastructure/terraform/bootstrap/
git commit -m "feat(infra): add Terraform state backend bootstrap module"
```

---

### Task 2: VPC

**Files:**
- Create: `infrastructure/terraform/versions.tf`
- Create: `infrastructure/terraform/providers.tf`
- Create: `infrastructure/terraform/variables.tf`
- Create: `infrastructure/terraform/locals.tf`
- Create: `infrastructure/terraform/vpc.tf`

**Interfaces:**
- Produces: `module.vpc` with outputs `vpc_id`, `private_subnets`, `public_subnets`,
  `database_subnet_group_name`, `elasticache_subnet_group_name` — every later task in this plan
  references these by exactly those names.
- Produces: `local.cluster_name`, `local.tags` — every later task's resources use these for naming
  and tagging.

- [ ] **Step 1: Write `infrastructure/terraform/versions.tf`**

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
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
```

- [ ] **Step 2: Write `infrastructure/terraform/providers.tf`**

```hcl
provider "aws" {
  region = var.aws_region
}
```

Later tasks append `kubernetes`/`helm`/`kubectl` provider blocks to this same file — don't add
them now, they reference `module.eks`, which doesn't exist until Task 3.

- [ ] **Step 3: Write `infrastructure/terraform/variables.tf`**

```hcl
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
```

Later tasks append more variables to this same file as they need them.

- [ ] **Step 4: Write `infrastructure/terraform/locals.tf`**

```hcl
locals {
  cluster_name = "${var.project_name}-${var.environment}"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
```

- [ ] **Step 5: Write `infrastructure/terraform/vpc.tf`**

```hcl
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
  azs               = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets   = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets    = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 2)]
  database_subnets  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 4)]

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
```

- [ ] **Step 6: Format, initialize, and validate**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false
terraform validate
```

Expected: same three outcomes as Task 1's Step 4. `terraform init` downloads the real
`terraform-aws-modules/vpc/aws` module from the registry — confirm no download errors.

- [ ] **Step 7: Run tflint**

```bash
tflint --init
tflint
```

Expected: no output (0 issues). `tflint --init` downloads the `terraform` ruleset plugin the first
time it runs in a fresh checkout — only needs to happen once.

- [ ] **Step 8: Clean up local artifacts and commit**

```bash
rm -rf infrastructure/terraform/.terraform
git add infrastructure/terraform/versions.tf infrastructure/terraform/providers.tf \
  infrastructure/terraform/variables.tf infrastructure/terraform/locals.tf \
  infrastructure/terraform/vpc.tf
git commit -m "feat(infra): add VPC module"
```

---

### Task 3: EKS cluster (Fargate) and the AWS Load Balancer Controller

**Files:**
- Modify: `infrastructure/terraform/versions.tf` (add `kubernetes` and `helm` to
  `required_providers`)
- Modify: `infrastructure/terraform/providers.tf` (add `kubernetes` and `helm` provider blocks)
- Modify: `infrastructure/terraform/variables.tf` (add `kubernetes_version`)
- Create: `infrastructure/terraform/eks.tf`
- Create: `infrastructure/terraform/eks-addons.tf`

**Interfaces:**
- Consumes: `module.vpc.vpc_id`, `module.vpc.private_subnets` (Task 2).
- Produces: `module.eks` with outputs `cluster_name`, `cluster_endpoint`,
  `cluster_certificate_authority_data`, `cluster_security_group_id`, `oidc_provider_arn` — Task 4
  uses `cluster_security_group_id`; Task 5 and Task 6 use the cluster endpoint/CA (indirectly,
  through the provider blocks this task adds); Task 6's outputs use `cluster_name`/
  `cluster_endpoint`.
- Produces: `module.load_balancer_controller_irsa.arn` — consumed only inside this task's own
  `eks-addons.tf`.

- [ ] **Step 1: Extend `infrastructure/terraform/versions.tf`**

Add `kubernetes` and `helm` to the `required_providers` block — the full block becomes:

```hcl
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
  }
```

- [ ] **Step 2: Extend `infrastructure/terraform/providers.tf`**

Append (don't replace the existing `provider "aws"` block):

```hcl

# EKS auth via a short-lived token from `aws eks get-token` (the exec plugin below) instead of a
# static aws_eks_cluster_auth data source token — the latter is cached in state and can go stale
# mid-apply on a long-running plan; exec always fetches a fresh one.
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}
```

`kubernetes {}` and `exec {}` are nested **blocks** here, not attributes with `= {`  — this
provider version (`~> 2.16`) rejects the object-attribute syntax some newer Terraform docs show.
Confirmed by running `terraform validate` against both forms while writing this plan; the block
form is the one that passes.

- [ ] **Step 3: Extend `infrastructure/terraform/variables.tf`**

Append:

```hcl

variable "kubernetes_version" {
  description = "EKS control plane Kubernetes version."
  type        = string
  default     = "1.34"
}
```

- [ ] **Step 4: Write `infrastructure/terraform/eks.tf`**

```hcl
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
```

Note the input names: `endpoint_public_access`/`endpoint_private_access` (not
`cluster_endpoint_public_access` — that name belongs to an older major version of this module and
`terraform validate` rejects it against `~> 21.0`), and `name`/`kubernetes_version` (not
`cluster_name`/`cluster_version`).

- [ ] **Step 5: Write `infrastructure/terraform/eks-addons.tf`**

```hcl
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
```

`set { name = ... value = ... }` is a repeated block, same reasoning as Step 2 — not a `set = [...]`
list attribute (that syntax belongs to a newer major version of this provider).

- [ ] **Step 6: Format, initialize, and validate**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false
terraform validate
tflint
```

Expected: all four clean, same as Task 2's Steps 6-7. `terraform init` this time also downloads
`terraform-aws-modules/eks/aws`, `terraform-aws-modules/iam/aws`, and the `kubernetes`/`helm`
providers — confirm none of those fail to resolve.

- [ ] **Step 7: Clean up and commit**

```bash
rm -rf infrastructure/terraform/.terraform
git add infrastructure/terraform/versions.tf infrastructure/terraform/providers.tf \
  infrastructure/terraform/variables.tf infrastructure/terraform/eks.tf \
  infrastructure/terraform/eks-addons.tf
git commit -m "feat(infra): add EKS cluster on Fargate and the AWS Load Balancer Controller"
```

---

### Task 4: RDS PostgreSQL and ElastiCache Valkey

**Files:**
- Modify: `infrastructure/terraform/variables.tf` (add `database_username`, `database_password`)
- Create: `infrastructure/terraform/data.tf`

**Interfaces:**
- Consumes: `module.vpc.vpc_id`, `module.vpc.database_subnet_group_name`,
  `module.vpc.elasticache_subnet_group_name` (Task 2); `module.eks.cluster_security_group_id`
  (Task 3).
- Produces: `aws_db_instance.core_server` (`.address`, `.endpoint`) and
  `aws_elasticache_replication_group.core_server` (`.primary_endpoint_address`) — Task 5's secrets
  and Task 6's outputs both reference these by exactly these resource names.

- [ ] **Step 1: Extend `infrastructure/terraform/variables.tf`**

Append:

```hcl

variable "database_username" {
  description = "Master username for the RDS PostgreSQL instance."
  type        = string
  default     = "ruguin"
}

variable "database_password" {
  description = "Master password for the RDS PostgreSQL instance."
  type        = string
  sensitive   = true
}
```

- [ ] **Step 2: Write `infrastructure/terraform/data.tf`**

```hcl
resource "aws_security_group" "rds" {
  name_prefix = "${local.cluster_name}-rds-"
  description = "Allows PostgreSQL access from pods running in the EKS cluster's VPC."
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from the cluster's pod security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_db_instance" "core_server" {
  identifier     = "${local.cluster_name}-core-server"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "ruguin"
  username = var.database_username
  password = var.database_password
  port     = 5432

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az = false

  backup_retention_period = 1
  skip_final_snapshot     = true

  tags = local.tags
}

resource "aws_security_group" "elasticache" {
  name_prefix = "${local.cluster_name}-elasticache-"
  description = "Allows Valkey access from pods running in the EKS cluster's VPC."
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Valkey from the cluster's pod security group"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_elasticache_replication_group" "core_server" {
  replication_group_id = "${local.cluster_name}-core-server"
  description           = "Valkey cache for core-server"
  engine                 = "valkey"
  engine_version         = "8.0"
  node_type               = "cache.t4g.micro"
  num_cache_clusters      = 1
  port                    = 6379

  subnet_group_name = module.vpc.elasticache_subnet_group_name
  security_group_ids = [aws_security_group.elasticache.id]

  automatic_failover_enabled = false

  tags = local.tags
}
```

Run `terraform fmt` in Step 3 before worrying about the alignment above — it's intentionally left
unaligned here; `terraform fmt` fixes column alignment automatically and this plan's own scratch
validation relied on that step, not on typing it pre-aligned.

- [ ] **Step 3: Format, initialize, and validate**

```bash
cd infrastructure/terraform
terraform fmt .
terraform init -backend=false
TF_VAR_database_password=placeholder terraform validate
tflint
```

`database_password` has no default (it's a real secret) — `terraform validate` still needs a value
to type-check against, hence `TF_VAR_database_password` here. Never pass a real password this way;
this is validation-only, nothing is applied.

Expected: `terraform fmt` reports the files it reformatted (that's fine, it's meant to fix the
alignment); `validate` and `tflint` both clean.

- [ ] **Step 4: Clean up and commit**

```bash
rm -rf infrastructure/terraform/.terraform
git add infrastructure/terraform/variables.tf infrastructure/terraform/data.tf
git commit -m "feat(infra): add RDS PostgreSQL and ElastiCache Valkey"
```

---

### Task 5: Kubernetes secrets and config (Terraform-managed)

**Files:**
- Modify: `infrastructure/terraform/variables.tf` (add `ghcr_username`, `ghcr_token`,
  `honeycomb_api_key`, `docs_username`, `docs_password`)
- Create: `infrastructure/terraform/secrets.tf`
- Create: `infrastructure/terraform/configmap.tf`

**Interfaces:**
- Consumes: `aws_db_instance.core_server.address`,
  `aws_elasticache_replication_group.core_server.primary_endpoint_address` (Task 4).
- Produces: a `kubernetes_secret.core_server_secrets` named `core-server-secrets`, a
  `kubernetes_secret.ghcr_pull` named `ghcr-pull-secret`, and a
  `kubernetes_config_map.core_server_config` named `core-server-config`, all in the `default`
  namespace — Task 7's Kubernetes Deployment manifest references these three names exactly
  (`envFrom` + `imagePullSecrets`), by name, not by any Terraform reference (Task 7's files are
  plain YAML ArgoCD syncs, outside Terraform entirely).

Every key below maps 1:1 to a variable `@ruguin/env` validates at core-server boot — see
`packages/env/src/packages/{database,cache,docs}.environment.ts` and
`packages/env/src/shared/server.environment.ts` for the exact schema each one is checked against.
Two values matter enough to call out explicitly, because getting either wrong doesn't fail loudly:

- `CACHE_DRIVER` must be exactly `valkey` — `packages/env/src/packages/cache.environment.ts`'s
  schema is `z.enum(['valkey', 'memory', 'noop'])`; the seemingly-obvious value `redis` is
  explicitly tested as rejected (`packages/env/src/packages/__tests__/cache.environment.unit.ts`,
  "rejects an unknown driver instead of silently falling back").
- `DATABASE_URL` must end in `?schema=core_server` — `resolveSchemaFrom()` in
  `apps/core-server/src/shared/infrastructure/database/prisma.service.ts` is the only place that
  schema gets read from; without the query parameter, Prisma silently falls back to the `public`
  schema instead of failing.

- [ ] **Step 1: Extend `infrastructure/terraform/variables.tf`**

Append:

```hcl

variable "ghcr_username" {
  description = "GitHub username that owns the GHCR Personal Access Token below — used to build the imagePullSecret core-server's Deployment references."
  type        = string
}

variable "ghcr_token" {
  description = "GHCR Personal Access Token with read:packages scope, used as the imagePullSecret for pulling ghcr.io/gravinawill/ruguin/core-server."
  type        = string
  sensitive   = true
}

variable "honeycomb_api_key" {
  description = "Honeycomb API key with send-events permission, used as OTEL_EXPORTER_OTLP_HEADERS' x-honeycomb-team value."
  type        = string
  sensitive   = true
}

variable "docs_username" {
  description = "Basic Auth username for core-server's /docs endpoint in production."
  type        = string
  default     = "docs"
}

variable "docs_password" {
  description = "Basic Auth password for core-server's /docs endpoint in production."
  type        = string
  sensitive   = true
}
```

- [ ] **Step 2: Write `infrastructure/terraform/secrets.tf`**

```hcl
resource "kubernetes_secret" "core_server_secrets" {
  metadata {
    name      = "core-server-secrets"
    namespace = "default"
  }

  data = {
    DATABASE_URL  = "postgresql://${var.database_username}:${var.database_password}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
    DOCS_PASSWORD = var.docs_password
    # x-honeycomb-team is the only header Honeycomb's OTLP endpoint requires for authentication.
    OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=${var.honeycomb_api_key}"
  }

  depends_on = [aws_db_instance.core_server]
}

resource "kubernetes_secret" "ghcr_pull" {
  metadata {
    name      = "ghcr-pull-secret"
    namespace = "default"
  }

  type = "kubernetes.io/dockerconfigjson"

  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        "ghcr.io" = {
          username = var.ghcr_username
          password = var.ghcr_token
          auth     = base64encode("${var.ghcr_username}:${var.ghcr_token}")
        }
      }
    })
  }
}
```

- [ ] **Step 3: Write `infrastructure/terraform/configmap.tf`**

```hcl
resource "kubernetes_config_map" "core_server_config" {
  metadata {
    name      = "core-server-config"
    namespace = "default"
  }

  data = {
    ENVIRONMENT = "production"
    PORT        = "3333"

    CACHE_PREFIX     = "ruguin:production"
    CACHE_DRIVER     = "valkey"
    CACHE_MASTER_URL = "redis://${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"

    DOCS_USERNAME = var.docs_username

    OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.honeycomb.io/v1/traces"
  }

  depends_on = [aws_elasticache_replication_group.core_server]
}
```

- [ ] **Step 4: Format, initialize, and validate**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false
TF_VAR_database_password=placeholder TF_VAR_ghcr_username=placeholder \
  TF_VAR_ghcr_token=placeholder TF_VAR_honeycomb_api_key=placeholder \
  TF_VAR_docs_password=placeholder terraform validate
tflint
```

Expected: `fmt` clean this time (Step 2 and 3's code above is already in canonical formatting);
`validate` and `tflint` both clean.

- [ ] **Step 5: Clean up and commit**

```bash
rm -rf infrastructure/terraform/.terraform
git add infrastructure/terraform/variables.tf infrastructure/terraform/secrets.tf \
  infrastructure/terraform/configmap.tf
git commit -m "feat(infra): provision core-server's database, cache and Honeycomb secrets"
```

---

### Task 6: ArgoCD bootstrap

**Files:**
- Modify: `infrastructure/terraform/versions.tf` (add `kubectl` to `required_providers`)
- Modify: `infrastructure/terraform/providers.tf` (add the `kubectl` provider block)
- Modify: `infrastructure/terraform/variables.tf` (add `argocd_repo_url`)
- Create: `infrastructure/terraform/argocd.tf`
- Create: `infrastructure/terraform/outputs.tf`

**Interfaces:**
- Consumes: `module.eks.cluster_name`, `module.eks.cluster_endpoint`,
  `module.eks.cluster_certificate_authority_data` (Task 3); `aws_db_instance.core_server.endpoint`,
  `aws_elasticache_replication_group.core_server.primary_endpoint_address` (Task 4, for outputs
  only).
- Produces: nothing later tasks in this plan consume — this is the last Terraform task. The
  `kubectl_manifest.core_server_application` resource it creates is what makes ArgoCD sync
  `infrastructure/k8s/core-server/` (Task 7) once that directory exists.

- [ ] **Step 1: Extend `infrastructure/terraform/versions.tf`**

Add to `required_providers`:

```hcl
    # hashicorp/kubernetes's own kubernetes_manifest resource validates against the target CRD's
    # schema at plan time — which doesn't exist yet on a first apply, since the ArgoCD Helm release
    # in this same module is what installs it. alekc/kubectl's kubectl_manifest resource applies
    # server-side without that plan-time validation, sidestepping the chicken-and-egg problem.
    kubectl = {
      source  = "alekc/kubectl"
      version = "~> 2.4"
    }
```

- [ ] **Step 2: Extend `infrastructure/terraform/providers.tf`**

Append:

```hcl

provider "kubectl" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  load_config_file       = false

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}
```

- [ ] **Step 3: Extend `infrastructure/terraform/variables.tf`**

Append:

```hcl

variable "argocd_repo_url" {
  description = "Git URL ArgoCD watches for infrastructure/k8s/core-server manifests."
  type        = string
  default     = "https://github.com/gravinawill/ruguin.git"
}
```

- [ ] **Step 4: Write `infrastructure/terraform/argocd.tf`**

```hcl
resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
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
        repoURL        = var.argocd_repo_url
        targetRevision = "HEAD"
        path           = "infrastructure/k8s/core-server"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "default"
      }
      syncPolicy = {
        automated = {
          prune    = true
          selfHeal = true
        }
        syncOptions = ["CreateNamespace=false"]
      }
    }
  })

  depends_on = [helm_release.argocd]
}
```

- [ ] **Step 5: Write `infrastructure/terraform/outputs.tf`**

```hcl
output "cluster_name" {
  description = "EKS cluster name — used with `aws eks update-kubeconfig --name <this>` to get kubectl access."
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = module.eks.cluster_endpoint
}

output "database_endpoint" {
  description = "RDS PostgreSQL connection endpoint (host:port)."
  value       = aws_db_instance.core_server.endpoint
}

output "cache_endpoint" {
  description = "ElastiCache Valkey primary endpoint address."
  value       = aws_elasticache_replication_group.core_server.primary_endpoint_address
}

output "argocd_namespace" {
  description = "Namespace ArgoCD is installed in — `kubectl -n <this> get pods` to check it's healthy."
  value       = kubernetes_namespace.argocd.metadata[0].name
}
```

- [ ] **Step 6: Format, initialize, and validate**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false
TF_VAR_database_password=placeholder TF_VAR_ghcr_username=placeholder \
  TF_VAR_ghcr_token=placeholder TF_VAR_honeycomb_api_key=placeholder \
  TF_VAR_docs_password=placeholder terraform validate
tflint
```

Expected: all four clean. This is the full main module now — every file this plan's Terraform
tasks create exists at this point, and this exact combination was validated while writing this
plan.

- [ ] **Step 7: Clean up and commit**

```bash
rm -rf infrastructure/terraform/.terraform
git add infrastructure/terraform/versions.tf infrastructure/terraform/providers.tf \
  infrastructure/terraform/variables.tf infrastructure/terraform/argocd.tf \
  infrastructure/terraform/outputs.tf
git commit -m "feat(infra): bootstrap ArgoCD and wire it to sync infrastructure/k8s/core-server"
```

---

### Task 7: core-server Kubernetes manifests

**Files:**
- Create: `infrastructure/k8s/core-server/deployment.yaml`
- Create: `infrastructure/k8s/core-server/service.yaml`

**Interfaces:**
- Consumes: the `core-server-config` ConfigMap, `core-server-secrets` Secret, and
  `ghcr-pull-secret` Secret by name (Task 5) — this task doesn't run through Terraform at all, so
  the reference is by Kubernetes name string, not a Terraform expression.
- Produces: nothing consumed by later tasks — this is what `kubectl_manifest.core_server_application`
  (Task 6) syncs, the end of the deploy chain.

These two files are plain Kubernetes YAML, not Terraform — ArgoCD applies them directly from this
path in the repository once Task 6's `Application` resource exists and points here.

- [ ] **Step 1: Write `infrastructure/k8s/core-server/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: core-server
  namespace: default
  labels:
    app: core-server
spec:
  replicas: 2
  selector:
    matchLabels:
      app: core-server
  template:
    metadata:
      labels:
        app: core-server
    spec:
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: core-server
          # sha-<commit> tag from release-image.yml's tagging scheme (see .github/workflows/
          # release-image.yml) — bump this line and let ArgoCD sync it for every new deploy;
          # there's no automation wiring a tag bump to this file yet (see the design doc's Risks).
          image: ghcr.io/gravinawill/ruguin/core-server:latest
          ports:
            - containerPort: 3333
              name: http
          envFrom:
            - configMapRef:
                name: core-server-config
            - secretRef:
                name: core-server-secrets
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
```

- [ ] **Step 2: Write `infrastructure/k8s/core-server/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: core-server
  namespace: default
  labels:
    app: core-server
  annotations:
    # Fargate pods have no EC2 instance for the legacy in-tree provider to target — these
    # annotations are what route this Service through the AWS Load Balancer Controller instead
    # (installed by Terraform, see infrastructure/terraform/eks-addons.tf), which supports
    # Fargate via IP-mode NLB targeting. See the design doc's decision 6.
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
spec:
  type: LoadBalancer
  selector:
    app: core-server
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
```

- [ ] **Step 3: Validate against the real Kubernetes schema, offline**

`kubectl apply --dry-run=client` tries to fetch the OpenAPI schema from a live cluster and fails
without one — use `kubeconform` instead, which bundles the real schemas and needs no cluster
connection. Install it first if it isn't already present:

```bash
which kubeconform || brew install kubeconform
kubeconform -strict -summary infrastructure/k8s/core-server/*.yaml
```

Expected: `Summary: 2 resources found in 2 files - Valid: 2, Invalid: 0, Errors: 0, Skipped: 0`.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/k8s/core-server/
git commit -m "feat(k8s): add core-server Deployment and Service manifests"
```

---

### Task 8: Close it out

**Files:**
- Modify: `docs/superpowers/specs/2026-08-03-production-eks-observability-design.md`

- [ ] **Step 1: Run the full validation suite one more time, from a clean state**

```bash
cd infrastructure/terraform
rm -rf .terraform .terraform.lock.hcl
terraform fmt -check -diff .
terraform init -backend=false
TF_VAR_database_password=placeholder TF_VAR_ghcr_username=placeholder \
  TF_VAR_ghcr_token=placeholder TF_VAR_honeycomb_api_key=placeholder \
  TF_VAR_docs_password=placeholder terraform validate
tflint
cd ../..
kubeconform -strict -summary infrastructure/k8s/core-server/*.yaml
terraform -chdir=infrastructure/terraform/bootstrap fmt -check -diff .
terraform -chdir=infrastructure/terraform/bootstrap init -backend=false
terraform -chdir=infrastructure/terraform/bootstrap validate
```

Expected: every command clean, same as each task's own Step 4/6 — this just confirms nothing
between tasks silently broke something an earlier task's own validation wouldn't have caught (a
real risk given later tasks edit files earlier tasks created).

- [ ] **Step 2: Clean up local init artifacts**

```bash
rm -rf infrastructure/terraform/.terraform infrastructure/terraform/bootstrap/.terraform
```

- [ ] **Step 3: Record the result in the spec**

Add a `## Resultado` section to
`docs/superpowers/specs/2026-08-03-production-eks-observability-design.md` with: confirmation that
the full validation suite passed clean end to end (Step 1's exact command list and outcome), the
list of real errors this plan's own authoring caught before they ever reached the plan document
(wrong EKS module input names, wrong Helm provider block syntax for both the `kubernetes` block
and `helm_release`'s `set` argument, an unused Terraform variable tflint caught), and a reminder of
what remains genuinely unverifiable without real AWS credentials: whether `terraform apply` itself
succeeds, whether the IAM policies IRSA grants are sufficient at runtime, whether Fargate actually
schedules pods the way the profiles assume.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-03-production-eks-observability-design.md
git commit -m "docs: record what production EKS + observability validation actually covered"
```

---

## Ordem e dependências

```
Task 1 (bootstrap)
  → Task 2 (VPC)
    → Task 3 (EKS + Fargate + LB Controller)
      → Task 4 (RDS + ElastiCache)
        → Task 5 (K8s secrets + config)
          → Task 6 (ArgoCD)
            → Task 7 (K8s manifests)
              → Task 8 (fechamento)
```

Estritamente sequencial — cada task edita arquivos que a anterior criou (`versions.tf`,
`providers.tf`, `variables.tf` crescem ao longo de quatro tasks diferentes), então a ordem acima
não é só lógica, é a única ordem em que cada task valida sozinha.

## Riscos conhecidos

- **Nada disto foi aplicado.** Toda validação neste plano é `terraform validate`/`fmt`/`tflint` e
  `kubeconform` — reais, rodados de verdade, mas nenhum substitui um `terraform apply` contra uma
  conta AWS real. A primeira aplicação real vai encontrar problemas que só aparecem em contato com
  a conta de verdade: cotas, nomes de recursos já em uso, uma versão de módulo que quebrou
  compatibilidade entre quando este plano foi escrito e quando for aplicado.
- **`REPLACE_WITH_BOOTSTRAP_STATE_BUCKET_NAME_OUTPUT` em `versions.tf` é um placeholder
  genuinamente inevitável** — o bloco `backend` do Terraform não aceita variável nem output de
  outro módulo, só literal. Preencher esse valor à mão, com o output real do Task 1, é o primeiro
  passo manual de quem for aplicar isto de verdade.
- **`image: ghcr.io/gravinawill/ruguin/core-server:latest` no Deployment é fixo.** Não existe
  automação bumping essa tag a cada novo `release-image.yml` — hoje é edição manual do arquivo
  (que o ArgoCD sincroniza sozinho depois de commitado). Um ArgoCD Image Updater resolveria isso,
  mas é escopo de uma onda futura, não desta.

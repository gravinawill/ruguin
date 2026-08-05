# Multi-Environment Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `core-server` a real `development` deployment alongside `production`, sharing the
same EKS/RDS/ElastiCache but isolated by Kubernetes namespace, Postgres schema, and cache prefix —
without reintroducing the merge-conflict risk the immutable-tags wave just fixed.

**Architecture:** `infrastructure/k8s/core-server/` becomes a Kustomize `base/` (environment-agnostic
Deployment + Service) with two overlays, `production/` and `development/`, each setting its own
namespace and pinned image digest via Kustomize's `images:` transformer. Two ArgoCD `Application`s
track them — production still follows `HEAD`, development follows the `develop` branch literally.
`release-image.yml`'s `promote` job resumes running on both branches, now safely, since each branch
only ever writes its own overlay's file.

**Tech Stack:** Kustomize (native `kubectl`/ArgoCD support, no new dependency), Terraform
(`kubernetes_namespace`, `kubectl_manifest`, existing ESO/IRSA machinery), GNU sed (already used by
`promote`).

## Global Constraints

- `base/` manifests are environment-agnostic: no `namespace:` field on any resource, no image
  tag/digest on the container's `image:` (bare `ghcr.io/gravinawill/ruguin/core-server`, no `:`/`@`
  suffix) — every environment-specific value comes from the overlay.
- Every environment's `images:` transformer entry pins by `digest:`, never `newTag:` — matches the
  already-established "immutable, not floating" decision from the previous wave.
- RDS and ElastiCache stay shared — no new `aws_db_instance`/`aws_elasticache_replication_group`.
  Development isolates via Postgres schema (`core_server_dev`) and `CACHE_PREFIX`
  (`ruguin:development`, matching the existing `ruguin:production` naming convention in
  `configmap.tf` — not `core-server:dev:` as an earlier draft of the design doc said).
- `core-server-dev`'s `ExternalSecret`s reuse the same 4 underlying secrets as production
  (`database_password`, `docs_password`, `honeycomb_api_key`, `ghcr_token`, `valkey_auth_token`) —
  no new `aws_secretsmanager_secret` resources, no new `random_password`.
- Development's ArgoCD `Application` sets `targetRevision = "develop"` (the literal branch name),
  not `HEAD` — production keeps `targetRevision = "HEAD"`.
- Development gets 1 replica (`replicas-patch.yaml`); production keeps the base's 2.
- No manual seed value needed for either overlay's placeholder digest — Task 1 seeds production's,
  Task 2 seeds development's, both with `sha256:` followed by 64 zeros (a syntactically valid but
  never-real digest), because no real digest is obtainable in this environment (no `read:packages`
  scope on the available GitHub token). The first real `promote` run on each branch replaces it.

---

### Task 1: Restructure into Kustomize `base/` + `production` overlay

Production keeps behaving identically after this task — same namespace, same replica count, same
image (now pinned via digest instead of `:latest`, continuing what the immutable-tags wave already
started). No development environment exists yet.

**Files:**

- Create: `infrastructure/k8s/core-server/base/deployment.yaml`
- Create: `infrastructure/k8s/core-server/base/service.yaml`
- Create: `infrastructure/k8s/core-server/base/kustomization.yaml`
- Create: `infrastructure/k8s/core-server/overlays/production/kustomization.yaml`
- Delete: `infrastructure/k8s/core-server/deployment.yaml`
- Delete: `infrastructure/k8s/core-server/service.yaml`
- Modify: `infrastructure/terraform/argocd.tf:44-51` (Application's `path`)
- Modify: `.github/workflows/release-image.yml:149-156` (promote job's target file/pattern)

**Interfaces:**

- Produces: `infrastructure/k8s/core-server/base/` (consumed by both overlays in Task 2),
  `infrastructure/k8s/core-server/overlays/production/kustomization.yaml` with an `images:` entry
  keyed `name: ghcr.io/gravinawill/ruguin/core-server` (Task 3's `promote` job writes this entry's
  `digest:` field).

- [ ] **Step 1: Create `base/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: core-server
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
      # core-server never calls the Kubernetes API, so the default token has nothing to do here.
      automountServiceAccountToken: false
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: core-server
          # Image is set per environment by each overlay's kustomization.yaml `images:`
          # transformer (overlays/production, overlays/development) — release-image.yml's
          # "promote" job rewrites the digest there automatically. Never hardcode a tag/digest
          # here; Kustomize matches this bare image name against each overlay's `images:` entry.
          image: ghcr.io/gravinawill/ruguin/core-server
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            capabilities:
              drop:
                - ALL
          ports:
            - containerPort: 3333
              name: http
          envFrom:
            - configMapRef:
                name: core-server-config
            - secretRef:
                name: core-server-secrets
          # Fargate sizes the pod's microVM from the sum of requests, so a limit above the request is
          # unreachable — matching them keeps what's declared and what's provisioned the same number.
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
              ephemeral-storage: 256Mi
            limits:
              cpu: 250m
              memory: 256Mi
              ephemeral-storage: 256Mi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
          # Deliberately not /health: that endpoint checks RDS and Valkey, so an outage in either
          # would restart every replica in a loop without fixing anything. Withdrawing from the
          # Service is the right response to a sick dependency, and that's readiness' job above.
          livenessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 15
            periodSeconds: 20
```

- [ ] **Step 2: Create `base/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: core-server
  labels:
    app: core-server
  annotations:
    # Fargate pods have no EC2 instance for the legacy in-tree provider to target — these
    # annotations are what route this Service through the AWS Load Balancer Controller instead
    # (installed by Terraform, see infrastructure/terraform/eks-addons.tf), which supports
    # Fargate via IP-mode NLB targeting.
    service.beta.kubernetes.io/aws-load-balancer-type: 'external'
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: 'ip'
    service.beta.kubernetes.io/aws-load-balancer-scheme: 'internet-facing'
# Known gap, deliberately deferred: this NLB serves plain HTTP on :80, no TLS termination.
# Terminating TLS here needs an ACM certificate (aws-load-balancer-ssl-cert annotation), which
# needs a domain name — neither exists in this Terraform yet. Out of scope until a domain is
# provisioned; tracked as a known risk, not a silent gap.
spec:
  type: LoadBalancer
  selector:
    app: core-server
  ports:
    - port: 80
      targetPort: http
      protocol: TCP
```

- [ ] **Step 3: Create `base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
```

- [ ] **Step 4: Create `overlays/production/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: core-server
resources:
  - ../../base
images:
  - name: ghcr.io/gravinawill/ruguin/core-server
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

- [ ] **Step 5: Delete the old flat manifests**

```bash
rm infrastructure/k8s/core-server/deployment.yaml infrastructure/k8s/core-server/service.yaml
```

- [ ] **Step 6: Verify the overlay builds correctly**

Install `kustomize` if not present: `brew install kustomize` (macOS) or see
https://kubectl.docs.kubernetes.io/installation/kustomize/ for other platforms.

```bash
kustomize build infrastructure/k8s/core-server/overlays/production > /tmp/prod-build.yaml
grep -c "kind: Deployment" /tmp/prod-build.yaml
grep -c "kind: Service" /tmp/prod-build.yaml
grep "namespace: core-server" /tmp/prod-build.yaml
grep "replicas: 2" /tmp/prod-build.yaml
grep "image: ghcr.io/gravinawill/ruguin/core-server@sha256:0000000000000000000000000000000000000000000000000000000000000000" /tmp/prod-build.yaml
grep "type: LoadBalancer" /tmp/prod-build.yaml
rm /tmp/prod-build.yaml
```

Expected: both `grep -c` lines print `1` (one Deployment, one Service — not duplicated or
missing), and every subsequent `grep` finds exactly one match, confirming namespace, replica
count, pinned image, and Service type all made it through the base+overlay composition
unchanged in substance from the original flat manifests.

- [ ] **Step 7: Update `argocd.tf`'s Application path**

In `infrastructure/terraform/argocd.tf`, find:

```hcl
        # The image is pinned to a digest by release-image.yml's "promote" job (only runs on
        # push to master, after a build is scanned and signed) — HEAD stays correct to track
        # here because this directory only changes via that deliberate commit, not implicitly.
        targetRevision = "HEAD"
        path           = "infrastructure/k8s/core-server"
```

Replace with:

```hcl
        # The image is pinned to a digest by release-image.yml's "promote" job (only runs on
        # push to master, after a build is scanned and signed) — HEAD stays correct to track
        # here because this directory only changes via that deliberate commit, not implicitly.
        targetRevision = "HEAD"
        path           = "infrastructure/k8s/core-server/overlays/production"
```

- [ ] **Step 8: Validate the Terraform change**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
terraform validate
cd ../..
rm -rf infrastructure/terraform/.terraform
```

Expected: `terraform fmt` prints nothing (already formatted), `terraform validate` prints
`Success! The configuration is valid.`

- [ ] **Step 9: Point `promote` at the new overlay file**

In `.github/workflows/release-image.yml`, find:

```yaml
      - name: Update deployment image digest
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::refusing to promote invalid digest '$DIGEST'"; exit 1; }
          sed -i -E "s#image: ${IMAGE}(:[^[:space:]]+|@sha256:[a-f0-9]+)#image: ${IMAGE}@${DIGEST}#" \
            infrastructure/k8s/core-server/deployment.yaml
        env:
          IMAGE: ${{ env.IMAGE }}
          DIGEST: ${{ needs.image.outputs.digest }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- infrastructure/k8s/core-server/deployment.yaml && exit 0
          git add infrastructure/k8s/core-server/deployment.yaml
          git commit -m "chore(deploy): promote core-server to ${DIGEST}"
```

Replace with:

```yaml
      - name: Update deployment image digest
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::refusing to promote invalid digest '$DIGEST'"; exit 1; }
          sed -i -E "s#digest: sha256:[0-9a-f]+#digest: ${DIGEST}#" \
            infrastructure/k8s/core-server/overlays/production/kustomization.yaml
        env:
          DIGEST: ${{ needs.image.outputs.digest }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- infrastructure/k8s/core-server/overlays/production && exit 0
          git add infrastructure/k8s/core-server/overlays/production
          git commit -m "chore(deploy): promote core-server (production) to ${DIGEST}"
```

Leave everything else in that job (the `if:` condition, the retry loop, `IMAGE` no longer being
needed as a step env var since the new `sed` pattern doesn't reference it) exactly as-is — only
these two blocks change. `IMAGE` was only used by the old `sed` pattern; removing it from the
first step's `env:` block is correct since nothing else in that step references it anymore.

- [ ] **Step 10: Validate the workflow**

```bash
actionlint .github/workflows/release-image.yml
```

Expected: no output, exit code 0.

- [ ] **Step 11: Re-verify the sed substitution against the real overlay file**

```bash
SED=$(command -v gsed || command -v sed)
cp infrastructure/k8s/core-server/overlays/production/kustomization.yaml /tmp/prod-kustomization.yaml
NEW_DIGEST="sha256:1111111111111111111111111111111111111111111111111111111111111111"
"$SED" -i -E "s#digest: sha256:[0-9a-f]+#digest: ${NEW_DIGEST}#" /tmp/prod-kustomization.yaml
grep -qF "digest: ${NEW_DIGEST}" /tmp/prod-kustomization.yaml && echo "PASS: digest substitution works against the real file" || echo "FAIL"
kustomize build /tmp/prod-kustomization.yaml 2>&1 | head -1 || true
rm /tmp/prod-kustomization.yaml
```

(The `kustomize build` line on a lone file rather than a directory is expected to error — it's
only there as a sanity check that the file is still parseable YAML after the substitution, not a
real build attempt. The `grep` line is the actual pass/fail signal.)

- [ ] **Step 12: Commit**

```bash
git add infrastructure/k8s/core-server infrastructure/terraform/argocd.tf .github/workflows/release-image.yml
git commit -m "feat(infra): restructure core-server manifests into Kustomize base+overlay

Production keeps behaving identically — same namespace, replica count,
and image — now composed from an environment-agnostic base instead of
flat manifests, so a development overlay can reuse it without
duplicating the Deployment/Service definitions."
```

---

### Task 2: Add the `development` environment

**Files:**

- Create: `infrastructure/k8s/core-server/overlays/development/kustomization.yaml`
- Create: `infrastructure/k8s/core-server/overlays/development/replicas-patch.yaml`
- Modify: `infrastructure/terraform/argocd.tf` (new namespace + Application)
- Modify: `infrastructure/terraform/external-secrets.tf` (new `ExternalSecret`s)
- Modify: `infrastructure/terraform/configmap.tf` (new `ConfigMap`)
- Modify: `infrastructure/terraform/eks.tf` (new Fargate profile)

**Interfaces:**

- Consumes: `infrastructure/k8s/core-server/base/` (from Task 1) — reused as-is, no changes.
- Produces: `infrastructure/k8s/core-server/overlays/development/kustomization.yaml` with an
  `images:` entry keyed `name: ghcr.io/gravinawill/ruguin/core-server` (Task 3's `promote` job
  writes this entry's `digest:` field, same as Task 1's production overlay).

- [ ] **Step 1: Create `overlays/development/replicas-patch.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: core-server
spec:
  replicas: 1
```

- [ ] **Step 2: Create `overlays/development/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: core-server-dev
resources:
  - ../../base
patches:
  - path: replicas-patch.yaml
    target:
      kind: Deployment
      name: core-server
images:
  - name: ghcr.io/gravinawill/ruguin/core-server
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
```

- [ ] **Step 3: Verify the development overlay builds correctly**

```bash
kustomize build infrastructure/k8s/core-server/overlays/development > /tmp/dev-build.yaml
grep "namespace: core-server-dev" /tmp/dev-build.yaml
grep "replicas: 1" /tmp/dev-build.yaml
grep "image: ghcr.io/gravinawill/ruguin/core-server@sha256:0000000000000000000000000000000000000000000000000000000000000000" /tmp/dev-build.yaml
grep "type: LoadBalancer" /tmp/dev-build.yaml
rm /tmp/dev-build.yaml
```

Expected: every `grep` finds exactly one match — development's namespace, 1 replica (not
inheriting production's 2), pinned image, and its own `LoadBalancer` Service (inherited from
`base/service.yaml` automatically, no patch needed for that).

- [ ] **Step 4: Add the `core-server-dev` namespace and ArgoCD `Application`**

In `infrastructure/terraform/argocd.tf`, after the existing `kubectl_manifest.core_server_application`
resource (end of file), add:

```hcl

resource "kubernetes_namespace" "core_server_dev" {
  metadata {
    name = "core-server-dev"
  }

  depends_on = [module.eks]
}

resource "kubectl_manifest" "core_server_dev_application" {
  yaml_body = yamlencode({
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata = {
      name      = "core-server-dev"
      namespace = kubernetes_namespace.argocd.metadata[0].name
    }
    spec = {
      project = "default"
      source = {
        repoURL = var.argocd_repo_url
        # Unlike production's Application above, this tracks the literal "develop" branch, not
        # HEAD (which resolves to the repo's default branch, master) — development follows
        # develop specifically, independent of whatever master is doing.
        targetRevision = "develop"
        path           = "infrastructure/k8s/core-server/overlays/development"
      }
      destination = {
        server    = "https://kubernetes.default.svc"
        namespace = "core-server-dev"
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

  depends_on = [helm_release.argocd, kubernetes_namespace.core_server_dev]
}
```

- [ ] **Step 5: Add the `core-server-dev-config` ConfigMap**

In `infrastructure/terraform/configmap.tf`, after the existing `kubernetes_config_map.core_server_config`
resource, add:

```hcl

resource "kubernetes_config_map" "core_server_dev_config" {
  metadata {
    name      = "core-server-config"
    namespace = "core-server-dev"
  }

  data = {
    ENVIRONMENT = "development"
    PORT        = "3333"

    # Same RDS/ElastiCache as production (see external-secrets.tf's core_server_dev_secrets for
    # the schema/prefix that actually isolates development's data) — CACHE_PREFIX here only
    # needs to differ from production's "ruguin:production" to avoid key collisions.
    CACHE_PREFIX = "ruguin:development"
    CACHE_DRIVER = "valkey"

    DOCS_USERNAME = var.docs_username

    OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.honeycomb.io/v1/traces"
  }

  depends_on = [kubernetes_namespace.core_server_dev]
}
```

Note: `kubernetes_namespace.core_server_dev` is defined in `argocd.tf` (Step 4) — Terraform
resolves cross-file references within the same module automatically, no explicit import needed.

- [ ] **Step 6: Add development's `ExternalSecret`s**

In `infrastructure/terraform/external-secrets.tf`, after the existing `kubectl_manifest.ghcr_pull`
resource (end of file), add:

```hcl

# Same 4 underlying secrets as core_server_secrets above — development shares production's RDS
# and ElastiCache, so there is no separate database_password or valkey_auth_token to read. Only
# DATABASE_URL/CACHE_MASTER_URL differ, via the schema/prefix embedded in the template below.
resource "kubectl_manifest" "core_server_dev_secrets" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "core-server-secrets"
      namespace = "core-server-dev"
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
            DATABASE_URL               = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server_dev"
            CACHE_MASTER_URL           = "rediss://:{{ .valkeyAuthToken }}@${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"
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
        { secretKey = "honeycombApiKey", remoteRef = { key = aws_secretsmanager_secret.honeycomb_api_key.name } },
        { secretKey = "valkeyAuthToken", remoteRef = { key = aws_secretsmanager_secret.valkey_auth_token.name } }
      ]
    }
  })

  depends_on = [
    kubectl_manifest.cluster_secret_store,
    aws_db_instance.core_server,
    aws_elasticache_replication_group.core_server,
    aws_secretsmanager_secret_version.valkey_auth_token,
    kubernetes_namespace.core_server_dev
  ]
}

# core-server-dev's Deployment references imagePullSecrets: ghcr-pull-secret (inherited from
# base/deployment.yaml) — Kubernetes Secrets don't cross namespaces, so this ExternalSecret is
# needed even though it reads the exact same ghcr_token as production's ghcr_pull above.
resource "kubectl_manifest" "core_server_dev_ghcr_pull" {
  yaml_body = yamlencode({
    apiVersion = "external-secrets.io/v1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "ghcr-pull-secret"
      namespace = "core-server-dev"
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

  depends_on = [kubectl_manifest.cluster_secret_store, kubernetes_namespace.core_server_dev]
}
```

- [ ] **Step 7: Add the `core-server-dev` Fargate profile**

In `infrastructure/terraform/eks.tf`, find:

```hcl
    external_secrets = {
      name = "external-secrets"
      selectors = [
        { namespace = "external-secrets" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
  }
```

Replace with:

```hcl
    external_secrets = {
      name = "external-secrets"
      selectors = [
        { namespace = "external-secrets" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
    core_server_dev = {
      name = "core-server-dev"
      selectors = [
        { namespace = "core-server-dev" }
      ]
      subnet_ids = module.vpc.private_subnets
    }
  }
```

- [ ] **Step 8: Validate the Terraform changes**

```bash
cd infrastructure/terraform
terraform fmt -check -diff .
terraform init -backend=false -input=false
TF_VAR_database_username=placeholder TF_VAR_docs_username=placeholder \
  TF_VAR_ghcr_username=placeholder TF_VAR_argocd_repo_url=placeholder \
  TF_VAR_eks_public_access_cidrs='["10.0.0.0/8"]' terraform validate
cd ../..
rm -rf infrastructure/terraform/.terraform
```

Expected: `terraform fmt` prints nothing, `terraform validate` prints `Success! The configuration
is valid.` (The `TF_VAR_*` values are placeholders satisfying required-variable validation only —
`terraform validate` never contacts AWS.)

- [ ] **Step 9: Commit**

```bash
git add infrastructure/k8s/core-server/overlays/development infrastructure/terraform/argocd.tf \
  infrastructure/terraform/configmap.tf infrastructure/terraform/external-secrets.tf \
  infrastructure/terraform/eks.tf
git commit -m "feat(infra): add a development environment for core-server

Shares the same EKS/RDS/ElastiCache as production; isolated by
namespace (core-server-dev), Postgres schema (core_server_dev), and
CACHE_PREFIX. A second ArgoCD Application tracks the develop branch
literally, syncing infrastructure/k8s/core-server/overlays/development."
```

---

### Task 3: Resume `promote` on `develop`, routed to the right overlay

**Files:**

- Modify: `.github/workflows/release-image.yml`

**Interfaces:**

- Consumes: `infrastructure/k8s/core-server/overlays/production/kustomization.yaml` (Task 1) and
  `infrastructure/k8s/core-server/overlays/development/kustomization.yaml` (Task 2) — both already
  have the `images:` entry this task's `sed` pattern targets.

- [ ] **Step 1: Route `promote` by branch to the matching overlay**

In `.github/workflows/release-image.yml`, find:

```yaml
  promote:
    needs: image
    if: |
      github.event_name != 'pull_request' &&
      github.ref == 'refs/heads/master'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Update deployment image digest
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::refusing to promote invalid digest '$DIGEST'"; exit 1; }
          sed -i -E "s#digest: sha256:[0-9a-f]+#digest: ${DIGEST}#" \
            infrastructure/k8s/core-server/overlays/production/kustomization.yaml
        env:
          DIGEST: ${{ needs.image.outputs.digest }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- infrastructure/k8s/core-server/overlays/production && exit 0
          git add infrastructure/k8s/core-server/overlays/production
          git commit -m "chore(deploy): promote core-server (production) to ${DIGEST}"
          for attempt in 1 2 3; do
            echo "Push attempt $attempt/3..."
            if git push; then
              exit 0
            fi
            git pull --rebase origin "${GITHUB_REF_NAME}"
          done
          exit 1
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
```

Replace with:

```yaml
  promote:
    needs: image
    if: |
      github.event_name != 'pull_request' &&
      (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/master')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Update overlay image digest
        run: |
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::refusing to promote invalid digest '$DIGEST'"; exit 1; }
          sed -i -E "s#digest: sha256:[0-9a-f]+#digest: ${DIGEST}#" \
            "infrastructure/k8s/core-server/overlays/${OVERLAY}/kustomization.yaml"
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
          OVERLAY: ${{ github.ref_name == 'develop' && 'development' || 'production' }}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet -- "infrastructure/k8s/core-server/overlays/${OVERLAY}" && exit 0
          git add "infrastructure/k8s/core-server/overlays/${OVERLAY}"
          git commit -m "chore(deploy): promote core-server (${OVERLAY}) to ${DIGEST}"
          for attempt in 1 2 3; do
            echo "Push attempt $attempt/3..."
            if git push; then
              exit 0
            fi
            git pull --rebase origin "${GITHUB_REF_NAME}"
          done
          exit 1
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
          OVERLAY: ${{ github.ref_name == 'develop' && 'development' || 'production' }}
```

This is safe against the merge-conflict failure mode the previous wave found: `develop` only ever
writes `overlays/development/kustomization.yaml`, `master` only ever writes
`overlays/production/kustomization.yaml` — two different files, so `git flow release finish`
merging `develop` into `master` never touches the same line from both sides. The retry loop (for
the unrelated race with `release.yml`'s `@semantic-release/git` push, which only targets `master`)
stays on both branches for simplicity — it's a correct no-op on `develop`, where nothing else
pushes to that branch, and conditioning it by branch would add complexity without saving anything
real.

- [ ] **Step 2: Validate the workflow**

```bash
actionlint .github/workflows/release-image.yml
```

Expected: no output, exit code 0.

- [ ] **Step 3: Verify the branch-to-overlay routing logic**

```bash
# Simulate the GitHub Actions expression's two branches by hand — this is the exact ternary
# used in the workflow's OVERLAY env var, just evaluated in bash instead of GHA's expression
# syntax, since actionlint validates syntax but not runtime branch-value behavior.
for ref in develop master; do
  if [[ "$ref" == "develop" ]]; then overlay="development"; else overlay="production"; fi
  echo "ref=$ref -> overlay=$overlay"
done
```

Expected:
```text
ref=develop -> overlay=development
ref=master -> overlay=production
```

- [ ] **Step 4: Re-verify the sed substitution against both real overlay files**

```bash
SED=$(command -v gsed || command -v sed)
NEW_DIGEST="sha256:2222222222222222222222222222222222222222222222222222222222222222"

for overlay in production development; do
  cp "infrastructure/k8s/core-server/overlays/${overlay}/kustomization.yaml" "/tmp/${overlay}-kustomization.yaml"
  "$SED" -i -E "s#digest: sha256:[0-9a-f]+#digest: ${NEW_DIGEST}#" "/tmp/${overlay}-kustomization.yaml"
  grep -qF "digest: ${NEW_DIGEST}" "/tmp/${overlay}-kustomization.yaml" \
    && echo "PASS: ${overlay} overlay substitution works" \
    || echo "FAIL: ${overlay} overlay substitution"
  rm "/tmp/${overlay}-kustomization.yaml"
done
```

Expected: both lines print `PASS`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-image.yml
git commit -m "feat(ci): resume promoting on develop, routed to its own overlay

Safe now that production and development overlays are separate files
(infrastructure/k8s/core-server/overlays/{production,development}/) —
develop only ever writes its own overlay, so git flow release finish
merging develop into master never collides on the same line."
```

## Self-Review Notes

- **Spec coverage:** Decision 1 (namespace) → Task 2 Step 4. Decision 2 (schema/cache isolation) →
  Task 2 Steps 5-6 (`CACHE_PREFIX`, `?schema=core_server_dev`). Decision 3 (Kustomize base+overlays)
  → Task 1 Steps 1-4, Task 2 Steps 1-2 — verified against a real `kustomize build`, not just written
  by hand. Decision 4 (two Applications) → Task 1 Step 7, Task 2 Step 4. Decision 5 (promote resumes
  on develop) → Task 3. Decision 6 (development's own NLB) → covered by Task 2 inheriting
  `base/service.yaml`'s `type: LoadBalancer` automatically, no separate task needed — the design
  doc's self-review already caught that no patch file was required for this. Decision 7 (secrets
  reused) → Task 2 Step 6, including the `ghcr-pull-secret` gap the design doc's Decision 7 missed
  (caught while reading the real `external-secrets.tf` during planning — `core-server-dev`'s
  Deployment references `imagePullSecrets: ghcr-pull-secret`, which needs its own `ExternalSecret`
  per namespace same as `core-server-secrets` does). Decision 8 (ConfigMap, Fargate profile) → Task
  2 Steps 5, 7. Decision 9 (1 replica for development) → Task 2 Step 1.
- **Design doc correction:** the design doc's Decision 2 code example used `CACHE_PREFIX =
  "core-server:dev:"` — the real `configmap.tf` uses `"ruguin:production"` (project name, not app
  name, no trailing colon after the environment word). Task 2 Step 5 uses the real convention,
  `"ruguin:development"`.
- **No placeholders:** every YAML/HCL block is the literal content to write, not a description of
  it. The one seeded value that can't be a real digest (no registry read access in this
  environment) is documented as intentional in both the spec and this plan's Global Constraints,
  with the exact placeholder string given, not left as "TBD".
- **Type/interface consistency:** `OVERLAY` resolves identically (`github.ref_name == 'develop' &&
  'development' || 'production'`) in both steps of Task 3's `promote` job — Task 1's implementer
  fixed exactly this kind of two-different-derivations-of-the-same-value bug during the previous
  wave's final review, so Task 3 uses one expression, repeated verbatim in each step's `env:`
  block, never a bash-local variable computed once and assumed to survive into the next step (it
  wouldn't — each `run:` block is a fresh shell).

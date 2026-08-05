# Immutable Release Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `core-server`'s floating `:latest` image tag with an automatically-promoted, immutable digest, so ArgoCD only redeploys when a real, scanned-and-signed build actually changed.

**Architecture:** `.github/workflows/release-image.yml`'s existing `image` job exposes its build digest as a job output. A new `promote` job — running only on real pushes (never PRs) to `develop` or `master`, after `image` succeeds — rewrites `infrastructure/k8s/core-server/deployment.yaml`'s `image:` line to that digest and commits it back to the same branch. `paths-ignore` on the workflow's own push trigger stops that commit from re-triggering the workflow.

**Tech Stack:** GitHub Actions, GNU sed (the `ubuntu-latest` runner's default `sed`), `actionlint` for workflow-syntax validation.

## Global Constraints

- `IMAGE` stays `ghcr.io/${{ github.repository }}/core-server` — already defined at the workflow level, reused via `${{ env.IMAGE }}`, never redeclared.
- `promote` job's permissions are `contents: write` only — no broader scope, and no other job gains this permission.
- `promote` runs only when `github.event_name != 'pull_request'` AND the ref is `refs/heads/develop` or `refs/heads/master` (not on `v*` tag pushes — those point at a commit already promoted by its branch push).
- The `sed` substitution must use `#` as its delimiter, never `|` — verified empirically (both BSD and GNU sed) that `|` as both the delimiter and the regex alternation operator inside `(:[^[:space:]]+|@sha256:[a-f0-9]+)` silently no-ops the whole substitution.
- `infrastructure/terraform/argocd.tf`'s `targetRevision = "HEAD"` is not touched by this plan — the spec's Decision 3 explains why pinning the image digest is sufficient on its own.
- `develop` promotes too, even though no ArgoCD `Application` watches it yet — deliberate, per the spec's Decision 1 and Riscos.

---

### Task 1: Promote the build digest into `deployment.yaml` automatically

**Files:**

- Modify: `.github/workflows/release-image.yml`
- Modify: `infrastructure/k8s/core-server/deployment.yaml:27-30`

**Interfaces:**

- Produces: a `promote` job in `release-image.yml` that reads `needs.image.outputs.digest` (a new output added to the existing `image` job in this same task).

- [ ] **Step 1: Add `paths-ignore` to the push trigger**

In `.github/workflows/release-image.yml`, find:

```yaml
on:
  push:
    branches: [master, develop]
    tags: ['v*']
  pull_request:
    branches: [master, develop]
    types: [opened, synchronize, reopened]
```

Replace with:

```yaml
on:
  push:
    branches: [master, develop]
    tags: ['v*']
    paths-ignore: ['infrastructure/k8s/**']
  pull_request:
    branches: [master, develop]
    types: [opened, synchronize, reopened]
```

Without this, the `promote` job's own commit (which only touches
`infrastructure/k8s/**`) would re-trigger this same workflow on push, rebuilding the identical
code under a new commit and attempting to promote again.

- [ ] **Step 2: Expose the build digest as a job output**

In the same file, find:

```yaml
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
    steps:
```

Replace with:

```yaml
  image:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
```

- [ ] **Step 3: Add the `promote` job**

At the end of the same file (after the existing `image` job's final step, "Sign the image"),
append a new top-level job (same indentation as `image:` under `jobs:`):

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

      - name: Update deployment image digest
        run: |
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
          git push
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
```

- [ ] **Step 4: Validate the workflow with `actionlint`**

Run: `actionlint .github/workflows/release-image.yml`

Expected: no output, exit code 0 (matches the file's baseline before this task — confirmed
clean by running the same command before starting).

If `actionlint` isn't installed: `brew install actionlint` (macOS) or see
https://github.com/rhysd/actionlint/releases for other platforms — do not skip this step, it
is the only static check available for this file's syntax outside of a real CI run.

- [ ] **Step 5: Verify the sed substitution logic in isolation**

The `ubuntu-latest` runner's default `sed` is GNU sed. If developing on macOS, the system
`sed` is BSD sed and behaves differently for this exact pattern (confirmed during design: BSD
`sed -i -E "script"` silently consumes `-E` as the `-i` backup-suffix argument, downgrading to
basic-regex mode where `(...)`/`+` are treated as literal characters — the substitution then
matches nothing, with no error). Install GNU sed if needed: `brew install gnu-sed` (binary
lands at `/opt/homebrew/opt/gnu-sed/libexec/gnubin/sed` on Apple Silicon).

Run this verification (adjust the `sed` path if not on macOS):

```bash
SED=$(command -v gsed || command -v sed)
IMAGE="ghcr.io/gravinawill/ruguin/core-server"
DIGEST="sha256:abc123def456"

printf '          image: %s:latest\n' "$IMAGE" > /tmp/case1.yaml
"$SED" -i -E "s#image: ${IMAGE}(:[^[:space:]]+|@sha256:[a-f0-9]+)#image: ${IMAGE}@${DIGEST}#" /tmp/case1.yaml
grep -qF "image: ${IMAGE}@${DIGEST}" /tmp/case1.yaml && echo "PASS: :latest -> digest" || echo "FAIL: case1"

printf '          image: %s@sha256:0000000000000000000000000000000000000000000000000000000000000000\n' "$IMAGE" > /tmp/case2.yaml
"$SED" -i -E "s#image: ${IMAGE}(:[^[:space:]]+|@sha256:[a-f0-9]+)#image: ${IMAGE}@${DIGEST}#" /tmp/case2.yaml
grep -qF "image: ${IMAGE}@${DIGEST}" /tmp/case2.yaml && echo "PASS: old digest -> new digest" || echo "FAIL: case2"

printf '          name: core-server\n' > /tmp/case3.yaml
cp /tmp/case3.yaml /tmp/case3.expected
"$SED" -i -E "s#image: ${IMAGE}(:[^[:space:]]+|@sha256:[a-f0-9]+)#image: ${IMAGE}@${DIGEST}#" /tmp/case3.yaml
diff -q /tmp/case3.yaml /tmp/case3.expected > /dev/null && echo "PASS: unrelated line untouched" || echo "FAIL: case3"

rm -f /tmp/case1.yaml /tmp/case2.yaml /tmp/case3.yaml /tmp/case3.expected
```

Expected: all three lines print `PASS`. This exact test (with `command -v gsed || command -v
sed` resolving to GNU sed on the machine that designed this plan) already produced this result
during design — re-running it here is confirming the same logic still holds, not discovering
it fresh.

- [ ] **Step 6: Update `deployment.yaml`'s stale comment**

In `infrastructure/k8s/core-server/deployment.yaml`, find:

```yaml
          # sha-<commit> tag from release-image.yml's tagging scheme (see .github/workflows/
          # release-image.yml) — bump this line and let ArgoCD sync it for every new deploy;
          # there's no automation wiring a tag bump to this file yet (see the design doc's Risks).
          image: ghcr.io/gravinawill/ruguin/core-server:latest
```

Replace with:

```yaml
          # Rewritten automatically by release-image.yml's "promote" job on every push to
          # develop/master, to the exact digest that job just scanned (Trivy) and signed
          # (cosign) — never edit this line by hand, the next promote run overwrites it anyway.
          image: ghcr.io/gravinawill/ruguin/core-server:latest
```

The value stays `:latest` — no real digest is obtainable in this environment (no
`read:packages` scope on the available GitHub token, and anonymous `docker buildx imagetools
inspect` against this private GHCR package returns 403). This is not a gap: the `sed` pattern
from Step 3 already matches `:latest` as well as any prior `@sha256:...` value (proven in Step
5's case 1), so the very next real push to `develop` or `master` after this merges performs the
first substitution automatically. Note this explicitly in the task's commit message or PR
description so nobody mistakes the unchanged `:latest` for an oversight.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release-image.yml infrastructure/k8s/core-server/deployment.yaml
git commit -m "feat(ci): promote core-server's deployed image digest automatically

release-image.yml's new promote job rewrites deployment.yaml's image
line to the build digest it just scanned and signed, on every push to
develop/master. deployment.yaml still reads :latest until the next real
push performs the first automatic substitution — no read:packages scope
available here to seed a real digest by hand."
```

## Self-Review Notes

- **Spec coverage:** Decision 1 (promote job + digest output) → Steps 1-3. Decision 2
  (`paths-ignore`) → Step 1. Decision 3 (`targetRevision` unchanged) → no task needed, a Global
  Constraint documents why. Decision 4 (seed value) → Step 6, adjusted from "manual seed commit"
  to "documented no-op, first automatic run seeds it" once the design's own reasoning ("a
  primeira execução automática já funcionaria sem preparo manual") turned out to be the only
  achievable path in this environment (no registry read access).
- **No placeholders:** the `sed` pattern, the `promote` job YAML, and the verification script are
  all real, tested code — the delimiter bug from the first draft was caught by actually running
  it (Step 5's script is the exact command that caught it during design), not left for the
  implementer to discover.
- **Single task, deliberately:** the whole change is one cohesive mechanism spread across two
  files (the workflow that writes the digest, the manifest comment that now documents where it
  comes from) — splitting further would let a reviewer accept one half while rejecting the other,
  which doesn't make sense here; either the promotion mechanism works end to end or it doesn't.

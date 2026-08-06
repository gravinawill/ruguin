# ArgoCD

GitOps continuous delivery para o cluster. Definido em `infrastructure/terraform/argocd.tf`.

## Para que serve

Depois do bootstrap inicial (Terraform cria o ArgoCD e as `Application`s), qualquer mudança em `infrastructure/k8s/core-server/` (ver [core-server-kustomize.md](../../k8s/docs/core-server-kustomize.md)) sincroniza sozinha no cluster — sem precisar rodar `kubectl apply` nem `terraform apply` de novo. Só uma mudança na própria definição da `Application` (repo, path, project) volta a passar pelo Terraform.

## Como funciona

- Namespace `argocd` (`kubernetes_namespace.argocd`) + Helm chart `argo-cd` (`argoproj.github.io/argo-helm`, versão `10.2.2`).
- Duas `Application` CRs (via `kubectl_manifest`, não `kubernetes_manifest` — ver nota abaixo), uma por ambiente:
  - `core_server_application` — rastreia `targetRevision: HEAD` (resolve para a branch default, `master`), path `infrastructure/k8s/core-server/overlays/production`, sincroniza no namespace `core-server`.
  - `core_server_dev_application` — rastreia a branch **literal** `develop` (não `HEAD`), path `infrastructure/k8s/core-server/overlays/development`, sincroniza no namespace `core-server-dev`.
- `syncPolicy.automated` com `prune: true` e `selfHeal: true` — o ArgoCD corrige drift automaticamente e remove recursos que saíram do Git.
- `syncOptions: [CreateNamespace=false]` nos dois — os namespaces (`core-server`, `core-server-dev`) são gerenciados pelo Terraform (`kubernetes_namespace.core_server`/`core_server_dev`), o ArgoCD não tenta também ser dono do ciclo de vida deles.
- **Por que `kubectl_manifest` (provider `alekc/kubectl`) e não `kubernetes_manifest`** (provider oficial `hashicorp/kubernetes`): `kubernetes_manifest` valida contra o schema da CRD `Application` em tempo de `plan` — CRD que só existe depois do `helm_release.argocd` já ter rodado, no mesmo apply. `kubectl_manifest` aplica server-side sem essa validação prévia, evitando o problema do ovo e da galinha.
- **Pré-requisito de ordem de apply:** o `path` de cada `Application` só existe de verdade depois que a reestruturação para Kustomize já estiver em `master`/`develop` via merge real. Aplicar antes disso dá `ComparisonError` no ArgoCD, não um no-op limpo.

## Como usar

```bash
kubectl -n argocd get pods                              # checar se o ArgoCD está saudável
kubectl -n argocd get application core-server            # status de sync da produção
kubectl -n argocd get application core-server-dev        # status de sync do development
argocd app get core-server                                # via ArgoCD CLI, se instalado
```

Para forçar uma resincronização manual (normalmente desnecessário, dado `selfHeal: true`):

```bash
argocd app sync core-server
```

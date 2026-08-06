# Kustomize — core-server

Manifests Kubernetes do core-server, organizados com Kustomize (`base` + `overlays`). Vive em `infrastructure/k8s/core-server/`.

## Para que serve

Define o `Deployment` e o `Service` do core-server de um jeito que compartilha o essencial entre produção e development (mesmo container, mesmas probes, mesma estrutura de recursos) e só diferencia o que realmente muda por ambiente (réplicas, digest da imagem, namespace) — sem duplicar os YAMLs inteiros. É o que o [ArgoCD](../../terraform/docs/argocd.md) sincroniza automaticamente no cluster.

## Como funciona

### `base/`

- `deployment.yaml` — 2 réplicas (default, sobrescrito no overlay de development), container `core-server`:
  - `automountServiceAccountToken: false` — o core-server nunca chama a API do Kubernetes, então o token default não tem função aqui.
  - `securityContext` restrito: `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `runAsNonRoot: true`, todas as capabilities dropadas.
  - `imagePullSecrets: [ghcr-pull-secret]` — secret sincronizado pelo [External Secrets Operator](../../terraform/docs/external-secrets.md), para puxar a imagem do GHCR (registry privado).
  - `envFrom`: `configMapRef: core-server-config` + `secretRef: core-server-secrets` — ver [core-server-workload-config.md](../../terraform/docs/core-server-workload-config.md) e [external-secrets.md](../../terraform/docs/external-secrets.md).
  - `resources.requests == resources.limits` — no Fargate, o tamanho da microVM do pod é dimensionado pela soma dos `requests`; um `limit` acima do `request` seria inalcançável, então os dois são mantidos iguais.
  - `readinessProbe` em `/health` — remove o pod do Service se RDS/Valkey estiverem indisponíveis.
  - `livenessProbe` é **TCP**, não `/health` — de propósito: `/health` checa RDS e Valkey, então uma instabilidade em qualquer um dos dois reiniciaria todas as réplicas em loop sem corrigir nada. Retirar do Service (readiness) é a resposta certa a uma dependência doente; reiniciar o processo (liveness) não é.
  - `image: ghcr.io/gravinawill/ruguin/core-server` **sem tag nem digest** — cada overlay é quem fixa a versão real via o transformer `images:`. Nunca hardcodear um digest aqui; o Kustomize casa esse nome "nu" com a entrada `images:` de cada overlay.
- `service.yaml` — `type: LoadBalancer`, com annotations que roteiam via [AWS Load Balancer Controller](../../terraform/docs/aws-load-balancer-controller.md) (`external`, target-type `ip`, `internet-facing`) — necessário porque Fargate não tem instância EC2 para o provider legado apontar.
- `kustomization.yaml` — só lista os dois resources acima.

### `overlays/production/`

- `namespace: core-server`.
- `images:` fixa o digest real da imagem — sincronizado automaticamente pelo job "promote" do workflow `release-image.yml` a cada push em `master` (nunca editado à mão).

### `overlays/development/`

- `namespace: core-server-dev`.
- `patches/replicas-patch.yaml` — reduz para **1 réplica** (produção fica com o default de 2 do `base/`).
- `images:` segue a mesma lógica do overlay de produção, mas atualizado a cada push em `develop`.

### Placeholder de imagem

Os dois overlays nascem com um digest placeholder (`sha256:` + 64 zeros) — não existia um token com escopo `read:packages` disponível para semear um digest real no momento em que esses arquivos foram criados. **Nunca editar esse valor manualmente**: o job "promote" do `release-image.yml` sobrescreve com o digest real, já escaneado e assinado, no próximo push para a branch correspondente.

## Como usar

Não se aplica manualmente em condições normais — é o [ArgoCD](../../terraform/docs/argocd.md) quem roda `kustomize build` e sincroniza cada overlay no seu namespace, automaticamente, a cada mudança nesta pasta.

Para inspecionar o manifest renderizado localmente antes de commitar (útil para revisar um patch):

```bash
kubectl kustomize infrastructure/k8s/core-server/overlays/production
kubectl kustomize infrastructure/k8s/core-server/overlays/development
```

Para checar o estado real no cluster:

```bash
kubectl -n core-server get deployment core-server
kubectl -n core-server-dev get deployment core-server
```

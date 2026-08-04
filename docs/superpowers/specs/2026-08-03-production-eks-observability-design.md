# Production EKS + Observability — Design

**Data:** 2026-08-03
**Escopo:** `infrastructure/terraform/` (novo), `infrastructure/k8s/` (novo), o exporter OTel do
`core-server`
**Custo de cloud:** não é zero — primeira onda desta iniciativa que gasta dinheiro de verdade

## Contexto

As Ondas 1 e 2 fecharam o pipeline até um artefato de container assinado e um PR bem relatado, mas
nenhum dos dois é servido a ninguém: não existe onde o `core-server` rode em produção. O spec
original da iniciativa completa reservava essa infraestrutura para uma "Onda 2" separada (Terraform/
EKS/ArgoCD) e observabilidade para uma "Onda 3" — nesta sessão, a Onda 2 real acabou sendo o
relatório de qualidade de PR, então esta onda absorve as duas: hospedagem real e observabilidade,
juntas, porque observabilidade em produção não faz sentido sem produção.

A stack local de observabilidade (Loki/Tempo/Prometheus/Grafana, 12 tasks, já validada) permanece
`infrastructure/local/` — este documento não a substitui, ela continua servindo desenvolvimento. O
`core-server` já exporta traces via `OTEL_EXPORTER_OTLP_ENDPOINT` (padrão: coletor local), então a
integração de produção troca esse endpoint por Honeycomb.

**Restrição de execução:** este ambiente de trabalho não tem `aws` CLI, `terraform`, nem
credenciais AWS configuradas. Esta onda entrega o código Terraform completo, revisado e correto na
medida do possível — não um `terraform apply` real. Quem aplica, com suas próprias credenciais, é o
usuário.

## Objetivo

Um cluster EKS real (Fargate, sem node group EC2 para gerenciar), com banco de dados e cache
gerenciados, GitOps via ArgoCD observando este mesmo monorepo, e o `core-server` exportando
telemetria de produção direto para o Honeycomb — tudo como código Terraform revisável, pronto para
aplicar quando o usuário decidir.

## Decisões

### 1. Registro de imagem: GHCR, sem mudança

O App Runner (opção inicialmente cogitada) só aceita imagem de origem via Amazon ECR — verificado
contra a documentação oficial da AWS antes de descartar a opção. Kubernetes padrão, ao contrário,
puxa de qualquer registro via `imagePullSecrets` — um `Secret` do tipo `kubernetes.io/dockerconfigjson`
com um Personal Access Token do GHCR com escopo `read:packages`. A Onda 1 não muda em nada.

### 2. Compute: EKS com Fargate, não node group EC2

Zero instância EC2 para corrigir ou atualizar — o cluster usa `Fargate Profiles` (perfis para os
namespaces `default` e `kube-system`, este último necessário para o CoreDNS rodar sem node group).
Ainda é EKS "de verdade": control plane gerenciado pela AWS, API do Kubernetes padrão, mesmos
manifests que rodariam em qualquer outro EKS.

### 3. Rede: VPC dedicada, 2 AZs, subnets públicas e privadas

Módulo comunitário `terraform-aws-modules/vpc/aws` (não reinventar o que já é padrão de mercado) —
2 zonas de disponibilidade (mínimo para EKS), subnets públicas para o NAT Gateway e o Load Balancer,
privadas para os pods Fargate e os bancos gerenciados. Um NAT Gateway (não um por AZ) — reduz custo
pela metade às custas de um ponto único de saída de tráfego, aceitável para o estágio atual.

### 4. Cluster: módulo `terraform-aws-modules/eks/aws`

Mesma lógica do módulo de VPC: este é o módulo de fato-padrão do ecossistema Terraform para EKS,
mantido ativamente, usado pela própria documentação da AWS em exemplos. Reescrever os recursos
`aws_eks_cluster`/`aws_eks_fargate_profile` à mão à mão ganharia nada e perderia manutenção alheia.

### 5. Dados: RDS PostgreSQL 16 + ElastiCache Valkey

"Observabilidade em produção" pressupõe o serviço rodando de verdade, o que pressupõe banco e cache
reais — sem isso, o cluster sobe mas o `core-server` nunca fica saudável. `db.t4g.micro` (RDS) e
`cache.t4g.micro` (ElastiCache) — menor tamanho viável, adequado para um serviço sem tráfego de
produção real ainda. PostgreSQL 16 e o engine `valkey` nativo do ElastiCache espelham exatamente as
versões já usadas em `infrastructure/local/docker-compose.yml` (`postgres:16-alpine`,
`valkey/valkey:9-alpine`) — mesma superfície de compatibilidade, sem surpresa de versão entre
ambientes.

Multi-AZ desligado (custo dobra) e backup automático com retenção mínima (1 dia) — ajustável quando
houver tráfego real para justificar o custo de alta disponibilidade.

### 6. Exposição: AWS Load Balancer Controller obrigatório, mas só `Service` (NLB), não `Ingress`

Verificado contra a documentação oficial da AWS antes de assumir: pods em Fargate não têm instância
EC2 para o balanceador legado (`kube-controller-manager`'s in-tree provider) registrar como alvo —
esse controller antigo, o único capaz de criar um Load Balancer sem nenhuma peça extra, simplesmente
não enxerga Fargate. O **AWS Load Balancer Controller** (Helm chart + role IRSA) deixa de ser
opcional a partir do momento em que a decisão 2 escolheu Fargate — não há como expor o `core-server`
sem ele, com ou sem Ingress.

O que continua opcional é o `Ingress` (roteamento L7 por path): o controller cria tanto NLB quanto
ALB, então o `core-server` usa um `Service.spec.type: LoadBalancer` com as anotações
`service.beta.kubernetes.io/aws-load-balancer-type: "external"` e
`aws-load-balancer-nlb-target-type: "ip"` (tráfego direto para o pod, não para um node inexistente)
— um NLB simples, sem `Ingress`. Trocar para `Ingress`/ALB mais tarde, quando existir mais de um
serviço para rotear por path, não exige remover o controller nem recriar o cluster — só trocar o
tipo de recurso Kubernetes que o consome.

### 7. GitOps: ArgoCD bootstrado pelo Terraform, aplicações vivem neste monorepo

Terraform instala o ArgoCD via `helm_release` (provider Helm do Terraform) e, na sequência, aplica
o próprio recurso `Application` do ArgoCD (via `kubernetes_manifest`, no mesmo módulo) apontando
para `infrastructure/k8s/core-server/` neste repositório — o bootstrap termina com o ArgoCD já
sincronizando, sem passo manual entre "cluster existe" e "aplicação está rodando". A partir daí,
qualquer mudança nesse diretório sincroniza sozinha; só uma mudança na própria definição da
`Application` (repositório, path, projeto) volta a passar pelo Terraform.

Repositório único (não um repo de config separado): o projeto já centraliza tudo em um monorepo;
duplicar essa decisão para infraestrutura sem necessidade concreta seria inconsistente com o resto
do projeto.

### 8. Observabilidade: OTLP direto para o Honeycomb, sem Collector no cluster

`core-server`'s `resolveOtlpEndpoint()`
(`apps/core-server/src/shared/infrastructure/tracing/create-tracing-sdk.ts`) já lê
`OTEL_EXPORTER_OTLP_ENDPOINT` do ambiente — em produção, esse valor aponta para o endpoint OTLP do
Honeycomb, mais um header de autenticação (`x-honeycomb-team`) via variável de ambiente adicional.
Nenhuma peça nova no cluster: um Collector centralizando telemetria de múltiplos serviços só se
justifica quando existir mais de um serviço — a mesma lógica da decisão 6.

### 9. Terraform: bootstrap separado para o state remoto

`infrastructure/terraform/bootstrap/` — um módulo pequeno, com state **local** (não pode depender
do backend que ainda não existe), provisiona só um bucket S3 (versionado, criptografado) e uma
tabela DynamoDB (lock). `infrastructure/terraform/` (o módulo principal, com VPC/EKS/RDS/
ElastiCache/ArgoCD) usa esse bucket como backend remoto. Dois `terraform apply` na primeira vez
(bootstrap, depois o principal), um só nas seguintes.

### 10. Segredos: variáveis Terraform sensíveis, não Secrets Manager

A chave de API do Honeycomb e as credenciais do RDS/ElastiCache entram como variáveis Terraform
marcadas `sensitive = true`, passadas via um `.tfvars` não commitado (ou variáveis de ambiente
`TF_VAR_*` no momento do `apply`) e materializadas como `kubernetes_secret` pelo próprio Terraform.
AWS Secrets Manager + External Secrets Operator resolveria o mesmo problema com rotação automática,
mas é infraestrutura adicional (mais um controller, mais uma IRSA) que não se paga ainda com um
cluster de um serviço só — YAGNI, não descuido: a lacuna fica registrada nos Riscos.

## Fora de escopo

- Aplicar o Terraform de verdade — sem credenciais AWS neste ambiente (ver Restrição de execução).
- `Ingress` (roteamento L7 por path) — decisão 6. O AWS Load Balancer Controller em si **está** no
  escopo, como pré-requisito técnico do Fargate, não como opção.
- OTel Collector no cluster — decisão 8.
- Multi-AZ em RDS/ElastiCache, réplicas de leitura — sem tráfego real para justificar ainda.
- Os outros 5 serviços do product-spec — nenhum existe.
- GCP (Onda 4 original do spec inicial).
- AWS Secrets Manager / External Secrets Operator — decisão 10.
- CI/CD para o `infrastructure/k8s/` (o próprio ArgoCD já cobre sincronização; um workflow de
  validação de manifests — `kubeval`/`kubeconform` — é uma extensão natural, não incluída aqui).

## Riscos

- **Custo mensal real, mesmo sem tráfego**: control plane EKS (~US$73), Fargate (~US$15-30 para 2
  pods pequenos), NAT Gateway (~US$32 + tráfego), RDS `db.t4g.micro` (~US$13), ElastiCache
  `cache.t4g.micro` (~US$12), NLB (~US$16) — **~US$160-180/mês** antes de qualquer tráfego real.
  Não é uma estimativa precisa (preços variam por região e mudam), é ordem de grandeza para decidir
  se vale aplicar agora ou esperar.
- **Nada disto foi aplicado nem testado nesta sessão.** Todo o código é revisado por leitura e
  consistência interna, não por um `terraform plan`/`apply` real. A primeira aplicação real vai
  encontrar problemas que só aparecem em contato com a conta AWS de verdade — módulos de terceiros
  com breaking changes de versão, cotas de conta, nomes de recursos já em uso.
- **Segredos sem rotação** (decisão 10): aceitável para o estágio atual, mas é dívida a resolver
  antes de qualquer dado real de produção passar por esses serviços.
- **Um Load Balancer público sem WAF/autenticação de borda**: o `core-server` já tem seus próprios
  guards (Basic Auth em `/docs`, por exemplo), mas nada impede tráfego direto de chegar até a
  aplicação. Aceitável para um serviço ainda sem usuários reais; registrar como próximo passo antes
  de tráfego de produção de verdade.

## Resultado

**Suíte de validação completa, a partir de estado limpo (Task 8):**

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

Os oito comandos passaram limpos: `fmt` sem diffs nos dois módulos; `init -backend=false` baixou de
novo, do zero, todos os providers e módulos de terceiros do módulo principal (`eks` 21.24.1, `vpc`
6.6.1, `iam` 6.8.0, `kms` 4.0.0, entre outros) sem erro; `validate` reportou "Success! The
configuration is valid." nos dois módulos; `tflint` não encontrou nada a apontar; `kubeconform
-strict` reportou "2 resources found in 2 files - Valid: 2, Invalid: 0, Errors: 0, Skipped: 0". O
`.terraform.lock.hcl` do módulo principal, regenerado do zero, saiu idêntico ao já commitado —
nenhuma versão de provider mudou entre a escrita deste plano e esta validação final. Nada aqui
substitui um `apply` real (ver abaixo); é confirmação de que a sintaxe, os tipos e os módulos
referenciados continuam corretos.

**Erros reais que a autoria deste plano capturou antes de chegarem ao documento final:**

- A premissa original do spec de design — "AWS Load Balancer Controller opcional" — estava errada:
  pods Fargate não têm instância EC2 para o provider de load balancer in-tree (legado) apontar,
  então o Controller é obrigatório a partir do momento em que Fargate é a escolha de compute.
  Corrigido no spec de design antes do plano ser escrito (commit `539291c`, "fix(docs): the AWS
  Load Balancer Controller isn't optional on Fargate").
- Os nomes reais de input do `terraform-aws-modules/eks/aws` v21 são
  `endpoint_public_access`/`endpoint_private_access`, não `cluster_endpoint_public_access` (o nome
  de uma versão mais antiga do módulo) — capturado por um `terraform validate` real contra a versão
  real do módulo durante a autoria, antes do brief da Task 3 ser fechado.
- O provider `hashicorp/helm` 2.x exige sintaxe de bloco aninhado para o `exec {}` dentro de
  `provider "helm" { kubernetes { ... } }` e para as entradas `set {}` de `helm_release` — não a
  sintaxe de objeto/lista como atributo (`kubernetes = {...}`, `set = [...]`) que a documentação de
  uma versão major mais nova do provider mostra. Capturado por `terraform validate` reais durante a
  autoria; a implementação da Task 3 (este mesmo plano, já executado) confirmou as duas escolhas de
  sintaxe corretas na primeira tentativa.
- `tflint` capturou uma variável Terraform não usada (`core_server_image_tag`) durante validação de
  rascunho na autoria — removida antes do plano ser escrito, já que esse valor pertence ao
  Deployment do Kubernetes (Task 7), não ao módulo Terraform.
- Capturado por referência cruzada com o schema zod real deste repositório
  (`packages/env/src/packages/cache.environment.ts`) durante a autoria: um rascunho inicial do
  ConfigMap tinha `CACHE_DRIVER = "redis"` (valor que o schema rejeita explicitamente — só aceita
  `valkey`/`memory`/`noop`) e um nome de variável errado, `CACHE_URL` (o real é
  `CACHE_MASTER_URL`) — corrigido antes do plano ser escrito. A implementação e revisão da Task 5
  (este mesmo plano, já executado) confirmaram que os valores corrigidos (`CACHE_DRIVER =
  "valkey"`, `CACHE_MASTER_URL` com URL no esquema `redis://` — o nome do esquema é só o protocolo
  de fiação, não relacionado ao valor do driver) estão presentes em `infrastructure/terraform/
  configmap.tf` e corretos.
- `kubectl apply --dry-run=client` foi tentado primeiro para validação dos manifests K8s durante a
  autoria, mas essa versão do kubectl busca o schema OpenAPI do cluster ao vivo mesmo em dry run
  client-side, e falha sem conexão com um cluster real — trocado por `kubeconform -strict`, um
  validador de schema offline, que foi o que a Task 7 (já executada) de fato usou com sucesso.

**O que continua genuinamente não verificável sem credenciais AWS reais:** se o `terraform apply`
em si funciona de ponta a ponta; se as políticas IAM que o IRSA concede são suficientes em tempo de
execução; se o Fargate de fato agenda os pods do jeito que os profiles assumem. Nenhum comando
desta suíte — `fmt`/`init -backend=false`/`validate`/`tflint`/`kubeconform` — substitui um `apply`
real contra uma conta AWS; a primeira aplicação de verdade é o único jeito de confirmar essas três
coisas.

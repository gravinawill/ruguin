# EKS

Cluster Kubernetes gerenciado na AWS. Definido em `infrastructure/terraform/eks.tf`, via o módulo `terraform-aws-modules/eks/aws` (`~> 21.0`).

## Para que serve

É o cluster onde o core-server (e o resto da plataforma — ArgoCD, External Secrets) roda em produção, provisionado 100% em Fargate (sem node group EC2 para gerenciar).

## Como funciona

- Roda dentro da [VPC](vpc.md) (`module.vpc.private_subnets`), com endpoint público **e** privado habilitados: o público porque o Terraform roda de fora da VPC (sem VPN/bastion configurado nesse ambiente) e precisa alcançar a API para aplicar; o privado porque os pods do Fargate alcançam a API sem passar pelo NAT Gateway.
- `endpoint_public_access_cidrs` **não tem default** de propósito — o default do módulo em si é `0.0.0.0/0` (todo IPv4), o que seria um endpoint aberto para o mundo. Sem essa variável setada, o `apply` falha visivelmente em vez de abrir o endpoint silenciosamente.
- **Sem node group** — todo workload roda em Fargate. Cada namespace que roda pods precisa de um Fargate profile listado aqui: `kube-system`, `core-server`, `core-server-dev`, `argocd`, `external-secrets`.
- O profile do `kube-system` sozinho **não é suficiente** para o CoreDNS rodar: por padrão o EKS cria o Deployment do CoreDNS anotado `eks.amazonaws.com/compute-type: ec2`, preso a nós EC2 que esse cluster não tem. O bloco `addons.coredns` sobrescreve isso para `computeType: Fargate` — sem essa configuração, o CoreDNS fica `Pending` para sempre e nada no cluster resolve DNS.
- `enable_irsa = true` — habilita IAM Roles for Service Accounts, usado pelo [Load Balancer Controller](aws-load-balancer-controller.md) e pelo [External Secrets](external-secrets.md) para autenticar na AWS sem credenciais estáticas.
- `enable_cluster_creator_admin_permissions = true` — quem aplica o Terraform vira admin do cluster automaticamente.

## Como usar

```bash
aws eks update-kubeconfig --name <cluster_name>   # cluster_name vem do output "cluster_name"
kubectl get nodes                                  # não retorna nós EC2 — Fargate não aparece aqui
kubectl get pods -n core-server
```

Aplicado junto com o resto do módulo principal — ver [state-backend-bootstrap.md](state-backend-bootstrap.md) para o setup inicial do backend remoto antes do primeiro `terraform apply`.

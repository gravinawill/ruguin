# AWS Load Balancer Controller

Controller Kubernetes que provisiona Load Balancers da AWS a partir de Services/Ingresses. Definido em `infrastructure/terraform/eks-addons.tf`, instalado via `helm_release`.

## Para que serve

Pods do Fargate não têm instância EC2 para o provider de load balancer legado (in-tree) apontar — sem esse controller, o `Service type: LoadBalancer` do core-server (`infrastructure/k8s/core-server/base/service.yaml`, aplicado pelo ArgoCD, não pelo Terraform) nunca ganha um NLB funcional. Ele é o que de fato cria e mantém o Network Load Balancer que expõe o core-server à internet.

## Como funciona

- Helm chart `aws-load-balancer-controller` (`aws.github.io/eks-charts`), versão `3.5.0`, no namespace `kube-system`.
- Autentica na AWS via IRSA: o service account `aws-load-balancer-controller` assume a role criada por `module.load_balancer_controller_irsa` (definida em `eks.tf`, com a policy `attach_load_balancer_controller_policy`), sem credenciais estáticas.
- Recebe `clusterName`, `region` e `vpcId` do próprio [EKS](eks.md)/[VPC](vpc.md) via `set` — nada hardcoded.
- `depends_on = [module.eks]` — só instala depois do cluster existir.
- O Service do core-server usa target-type `ip` (não `instance`) nas suas annotations (`service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: 'ip'`) — é o modo compatível com Fargate, onde não existe uma instância EC2 para apontar.

## Como usar

Não se interage diretamente com o controller — ele reage a `Service`/`Ingress` do cluster. Para verificar que está saudável:

```bash
kubectl -n kube-system get pods -l app.kubernetes.io/name=aws-load-balancer-controller
kubectl -n core-server get service core-server   # EXTERNAL-IP populado = NLB provisionado
```

**Gap conhecido:** o NLB serve HTTP puro na porta 80, sem TLS — terminar TLS aqui precisaria de um certificado ACM (`aws-load-balancer-ssl-cert`), que por sua vez precisa de um domínio. Nenhum dos dois existe ainda neste Terraform; fora de escopo até um domínio ser provisionado (risco conhecido, não uma omissão silenciosa).

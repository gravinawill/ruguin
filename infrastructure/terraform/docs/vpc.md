# VPC

Rede privada na AWS onde todo o resto da infraestrutura (`eks.tf`, `data.tf`) roda. Definido em `infrastructure/terraform/vpc.tf`, via o módulo `terraform-aws-modules/vpc/aws` (`~> 6.6`).

## Para que serve

Isola a infraestrutura do produto numa rede própria, com subnets segregadas por função (pública, privada, database, cache) — é o pré-requisito de rede que o [EKS](eks.md) e os bancos ([RDS](rds-postgres.md), [ElastiCache](elasticache-valkey.md)) precisam para existir.

## Como funciona

- **2 AZs** — o mínimo que o EKS aceita. Escolhidas dinamicamente via `data.aws_availability_zones.available`, filtrando só AZs sem opt-in necessário.
- **CIDR `/16`** (`var.vpc_cidr`, default `10.0.0.0/16`), fatiado em `/20`s por função — 2 subnets de cada tipo (uma por AZ):
  - `private_subnets` — onde o EKS/Fargate e os bancos ficam.
  - `public_subnets` — para o NAT Gateway e Load Balancers internet-facing.
  - `database_subnets` — subnet group dedicado para o [RDS](rds-postgres.md).
  - `elasticache_subnets` — subnet group dedicado para o [ElastiCache](elasticache-valkey.md).
- **NAT Gateway único** (`single_nat_gateway = true`, não um por AZ) — troca resiliência (uma AZ inteira fica sem saída de internet se o NAT cair) por ~metade do custo mensal. Decisão aceitável para um cluster ainda sem tráfego de produção; revisar se isso mudar.
- Tags `kubernetes.io/role/elb` (subnets públicas) e `kubernetes.io/role/internal-elb` (subnets privadas), junto com `kubernetes.io/cluster/<nome>: shared` — é assim que o EKS e o AWS Load Balancer Controller descobrem automaticamente em quais subnets colocar ENIs do Fargate e Load Balancers, sem precisar configurar isso manualmente no cluster.
- DNS hostnames/support habilitados — necessário para service discovery interno funcionar.

## Como usar

Não se aplica isoladamente — é uma dependência implícita de todo o resto do módulo Terraform (`module.vpc.vpc_id`, `module.vpc.private_subnets` etc. são referenciados por [`eks.tf`](eks.md), [`data.tf`](rds-postgres.md)). Ver [state-backend-bootstrap.md](state-backend-bootstrap.md) para como aplicar o módulo principal pela primeira vez.

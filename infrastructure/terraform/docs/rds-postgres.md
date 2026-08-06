# RDS PostgreSQL

Banco relacional gerenciado do core-server em produção. Definido em `infrastructure/terraform/data.tf` (`aws_db_instance.core_server`).

## Para que serve

É o Postgres real do core-server rodando em produção/development na AWS — o equivalente em produção do service `postgres` do [docker-compose local](../../local/docs/postgres.md).

## Como funciona

- `postgres` 16, `db.t4g.micro`, storage `gp3` com 20 GB alocados (auto-scaling até 100 GB via `max_allocated_storage`), criptografado em repouso.
- Database `ruguin`, schema `core_server` para produção e `core_server_dev` para development — **é a mesma instância RDS** compartilhada entre os dois ambientes; o que isola os dados é o `schema` na connection string (ver [external-secrets.md](external-secrets.md)), não uma instância separada.
- **Senha gerenciada pela AWS** (`manage_master_user_password = true`) — o Terraform nunca vê nem guarda o valor no state; ele fica só no Secrets Manager, lido pelo [External Secrets Operator](external-secrets.md) via `master_user_secret[0].secret_arn`.
- Acesso de rede restrito: o security group `aws_security_group.rds` só libera a porta 5432 a partir do security group do próprio cluster [EKS](eks.md) — nada mais alcança o banco.
- `multi_az = false` — sem failover automático entre AZs (custo vs. disponibilidade; ver `vpc.tf` para a mesma lógica no NAT Gateway).
- `backup_retention_period = 7` dias — piso recomendado pela própria AWS para uma janela de recuperação real (1 dia só cobre erros do mesmo dia).
- `deletion_protection = true` — impede exclusão acidental via console/CLI. `skip_final_snapshot = false` garante um snapshot final se alguém desabilitar a proteção de propósito e deletar mesmo assim; o sufixo aleatório (`random_id.rds_final_snapshot`) evita colisão de nome entre um destroy/apply e outro.
- Logs do Postgres exportados para o CloudWatch (`enabled_cloudwatch_logs_exports = ["postgresql"]`).

## Como usar

```bash
terraform output database_endpoint    # host:port de conexão
```

A connection string real (`DATABASE_URL`) não é lida daqui diretamente — é montada e entregue ao core-server pelo [External Secrets Operator](external-secrets.md), a partir deste endpoint + a senha gerenciada.

Para acessar manualmente (ex.: debug), é preciso estar dentro da VPC (ou usar port-forward de um pod no cluster) — o security group não libera acesso externo.

# State backend (bootstrap)

Backend remoto do state do Terraform principal. Definido em `infrastructure/terraform/bootstrap/` — um módulo Terraform **separado**, com seu próprio state (local, não remoto).

## Para que serve

O módulo principal (`infrastructure/terraform/*.tf`) precisa de um backend S3 + lock DynamoDB para guardar seu state de forma segura e compartilhável entre quem aplica. Esse backend não pode ser criado pelo próprio módulo que vai usá-lo (problema do ovo e da galinha) — por isso existe este módulo `bootstrap/` à parte, aplicado uma única vez, manualmente, antes de tudo o resto.

## Como funciona

- `aws_s3_bucket.terraform_state` — bucket S3 para o `.tfstate`, com:
  - `prevent_destroy = true` (lifecycle) — protege contra um `terraform destroy` acidental apagar o próprio state de tudo.
  - Versionamento habilitado — permite recuperar uma versão anterior do state.
  - Criptografia server-side (AES256).
  - Bucket policy que **nega qualquer request fora de HTTPS** (`aws:SecureTransport = false`) — reforço extra, mesmo o AWS SDK já defaultando para TLS.
  - Public access block completo (ACLs e policies públicas bloqueadas).
  - Logging de acesso **deliberadamente não configurado** — precisaria de um bucket de destino separado (um bucket não pode logar para si mesmo), o que seria um bootstrap-antes-do-bootstrap. Gap conhecido e aceito para um bucket de baixo tráfego, não uma omissão silenciosa.
- `aws_dynamodb_table.terraform_lock` — tabela de lock (`LockID` como hash key, billing `PAY_PER_REQUEST`), impede dois `terraform apply` simultâneos corromperem o state. Também com `prevent_destroy = true`.

## Como usar

Só se aplica **uma vez**, antes do primeiro `terraform init` do módulo principal:

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform apply
terraform output state_bucket_name    # anote
terraform output lock_table_name      # anote (default: ruguin-terraform-lock)
```

Depois, edite `infrastructure/terraform/versions.tf` — o bloco `backend "s3"` não aceita variáveis nem output de outro módulo, então os dois valores acima precisam ser digitados manualmente nos placeholders `bucket` e `dynamodb_table` antes de rodar `terraform init` de verdade no módulo principal. Validações locais desse repo (que usam `-backend=false`) nunca leem esse bloco, então um placeholder desatualizado ali não quebra CI — só um `init` real.

```bash
cd infrastructure/terraform
terraform init   # agora lê o backend s3 configurado acima
```

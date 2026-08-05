# Valkey — criptografia em trânsito + AUTH token

## Contexto

`infrastructure/terraform/data.tf`'s `aws_elasticache_replication_group.core_server` hoje só tem
`at_rest_encryption_enabled = true` — o comentário no próprio recurso já documenta a lacuna:
"Transit encryption and an AUTH token are the missing half... deferred". Esta wave implementa o
que aquele comentário adiou, seguindo a mesma ordem de sub-waves de segurança aprovada
anteriormente (Secrets/ESO → **Valkey em trânsito** → tags imutáveis → TLS no NLB).

Diferente da senha do RDS (wave anterior), o ElastiCache não tem um recurso equivalente ao
`manage_master_user_password` — confirmado lendo o código-fonte real do provider AWS
(`aws_elasticache_replication_group`'s `auth_token` é `Optional, Sensitive`, mas **não**
`Computed`: a AWS não gera nem gerencia esse valor sozinha, e o Terraform precisa fornecê-lo no
momento da criação/atualização do recurso). O AUTH token vai para o Terraform state de qualquer
jeito — decisão já confirmada com o usuário: o Terraform gera o valor (`random_password`), em vez
de pedir a um operador para fornecê-lo manualmente, já que o resultado prático (o valor entra no
state) é o mesmo dos dois jeitos, e gerar automaticamente elimina um passo manual sem ganhar nada
em troca ao pedir para o operador.

## Decisões

### 1. `transit_encryption_enabled` + `auth_token` no `aws_elasticache_replication_group`

```hcl
resource "random_password" "valkey_auth_token" {
  length  = 32
  special = true
  # AWS permite !&#$^<>- como especiais em auth tokens do ElastiCache, mas restringimos ainda mais
  # aqui: '#' é delimitador de fragmento em URL, '&'/'<'/'>' têm significado especial em alguns
  # contextos de URL/HTML — nenhum dos quatro é necessário para atender o requisito da AWS (16-128
  # caracteres, pelo menos um não-alfanumérico), e evitar esse subconjunto elimina de vez qualquer
  # risco de o token quebrar o parsing da connection string, sem precisar de encoding especial.
  override_special = "!$^-"
}

resource "aws_elasticache_replication_group" "core_server" {
  # ... (demais argumentos inalterados)

  # AWS-managed KMS key, no application-side change.
  at_rest_encryption_enabled = true

  transit_encryption_enabled = true
  auth_token                 = random_password.valkey_auth_token.result
  # SET, não ROTATE: primeiro deploy, sem tráfego real ainda usando o replication group sem AUTH
  # — ROTATE existe para adicionar AUTH a um cluster já em produção sem downtime, não é o caso.
  auth_token_update_strategy = "SET"

  tags = local.tags
}
```

Requisitos do AUTH token confirmados na documentação oficial da AWS (não presumidos): 16-128
caracteres imprimíveis, não-alfanuméricos restritos a `!&#$^<>-`, proibidos `/`, `"`, `@`, `%`. AUTH
só pode ser habilitado com `transit_encryption_enabled = true` — por isso os dois argumentos
aparecem juntos.

### 2. O valor do token é espelhado no Secrets Manager — único caso em que o Terraform escreve o valor

Diferente dos outros secrets desta iniciativa (`docs_password`, `honeycomb_api_key`, `ghcr_token`,
todos populados manualmente por um operador), este é o único caso em que o próprio Terraform
gerencia o valor de principio a fim — porque ele nasce no Terraform (`random_password`), não existe
"operador" nenhum a quem pedir para fornecê-lo. Mesmo assim, o valor é espelhado num
`aws_secretsmanager_secret` novo em `infrastructure/terraform/external-secrets.tf`, para que
`CACHE_MASTER_URL` chegue ao cluster pelo mesmo mecanismo (`ExternalSecret`) que `DATABASE_URL` —
em vez de reintroduzir um `kubernetes_secret` direto só para este valor, o que seria dar um passo
atrás na consistência que a wave anterior estabeleceu.

```hcl
resource "aws_secretsmanager_secret" "valkey_auth_token" {
  name = "ruguin/production/valkey-auth-token"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "valkey_auth_token" {
  secret_id     = aws_secretsmanager_secret.valkey_auth_token.id
  secret_string = random_password.valkey_auth_token.result
}
```

A IAM policy do `module.external_secrets_irsa` (já existente) ganha mais um ARN na lista de
`resources` do statement `secrets_read`: `aws_secretsmanager_secret.valkey_auth_token.arn`.

### 3. `CACHE_MASTER_URL` sai do ConfigMap, entra no `ExternalSecret` existente

`infrastructure/terraform/configmap.tf` hoje declara:

```hcl
CACHE_MASTER_URL = "redis://${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"
```

Essa linha é removida do `kubernetes_config_map` — a partir de agora `CACHE_MASTER_URL` contém um
segredo (o AUTH token embutido na URL), então não pode continuar num ConfigMap em texto plano. Ela
se junta a `DATABASE_URL` no `template.data` do `ExternalSecret` `core_server_secrets` (já existente
em `external-secrets.tf`, da wave anterior):

```hcl
template = {
  data = {
    DATABASE_URL               = "postgresql://${var.database_username}:{{ .databasePassword }}@${aws_db_instance.core_server.address}:5432/ruguin?schema=core_server"
    CACHE_MASTER_URL           = "rediss://:{{ .valkeyAuthToken }}@${aws_elasticache_replication_group.core_server.primary_endpoint_address}:6379"
    DOCS_PASSWORD              = "{{ .docsPassword }}"
    OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team={{ .honeycombApiKey }}"
  }
}
```

E a lista `data` do mesmo `ExternalSecret` ganha mais uma entrada:

```hcl
{
  secretKey = "valkeyAuthToken"
  remoteRef = { key = aws_secretsmanager_secret.valkey_auth_token.name }
}
```

`rediss://:{{ .valkeyAuthToken }}@host:6379` — sem username antes dos dois-pontos: o ElastiCache
não usa RBAC/username neste setup, só o AUTH token clássico, e a sintaxe `scheme://:password@host`
(username vazio, password presente) é URL válida — o parser do `iovalkey` (`new URL(...)` do
WHATWG, a mesma API que o Node usa) já é comprovadamente capaz de extrair `username=''` e
`password='<token>'` desse formato.

Nada muda em `deployment.yaml`: `CACHE_MASTER_URL` continua chegando ao container como a mesma
variável de ambiente, só que via `envFrom.secretRef` em vez de `envFrom.configMapRef` — como as
duas fontes já são mescladas no mesmo `envFrom` hoje, o container não percebe a diferença.

### 4. Nenhuma mudança de código na aplicação

Confirmado lendo o código-fonte do `iovalkey` (biblioteca do driver Valkey usada em
`packages/cache`) numa wave anterior: o construtor `Redis` já detecta o esquema `rediss://`/
`valkeys://` na URL e ativa `tls: true` automaticamente, e `parseURL` já extrai `username`/
`password` do "userinfo" da URL sozinho — nada em `ValkeyConnectionManager` precisa mudar, porque
ele já recebe a URL completa como string e repassa direto para `new Redis(this.masterUrl, this.
options)`. `packages/env`'s schema (`CACHE_MASTER_URL: z.url().optional()`) já aceita qualquer
esquema de URL válido, `rediss://` incluído, sem alteração.

`num_cache_clusters = 1` hoje (sem réplicas em produção) — `CACHE_REPLICA_URLS` não é usado neste
ambiente, então esta wave não precisa tocar nele. Se réplicas forem adicionadas no futuro, o mesmo
raciocínio de URL/TLS se aplica a elas.

## Riscos

- **O AUTH token fica no Terraform state, diferente da senha do RDS.** Decisão já confirmada com o
  usuário: é uma limitação genuína do `aws_elasticache_replication_group` (sem equivalente ao
  `manage_master_user_password` do RDS), não uma escolha de design evitável. Mitigado pelas
  proteções que o backend S3 já tem (criptografia em repouso, bloqueio de acesso público, política
  que nega tráfego sem TLS) — as mesmas que já protegem os outros valores sensíveis que sempre
  estiveram no state (ex: os próprios ARNs e nomes de recursos).
- **`auth_token_update_strategy = "SET"` não é a escolha certa para uma atualização futura num
  cluster já em produção com tráfego real.** Se algum dia for preciso rotacionar este token depois
  do primeiro deploy, trocar para `"ROTATE"` primeiro é obrigatório — aplicar `SET` num cluster já
  servindo tráfego derruba conexões existentes que ainda não migraram para o token novo. Não é um
  problema desta wave (primeiro deploy, sem tráfego), mas fica registrado para quando a rotação for
  necessária.
- **Nenhuma verificação real de conexão TLS+AUTH contra um Valkey de verdade.** Assim como a wave
  do ESO, este ambiente não tem credenciais AWS nem um cluster real — a verificação fica limitada a
  `terraform validate`/`fmt`/`tflint`. A confirmação de que `rediss://:<token>@host:6379` realmente
  autentica e criptografa contra um ElastiCache real só acontece no primeiro `apply` de verdade.
- **`CACHE_PREFIX` e `CACHE_DRIVER` continuam no ConfigMap** — não são segredos, não precisam
  migrar. Só `CACHE_MASTER_URL` muda de lugar.
- **`override_special` do provider `random` já teve bug relatado** (hashicorp/terraform-provider-
  random#337: o resultado gerado podia conter caractere especial fora do conjunto declarado em
  `override_special`). O provider já está pinado em `~> 3.6` neste módulo (reaproveitado do
  `random_id` existente, nenhuma dependência nova). Baixo risco prático — mesmo um caractere fora
  do conjunto pretendido ainda respeitaria os limites que a AWS aceita, contanto que a implementação
  confirme isso lendo o valor gerado (via `terraform console` ou similar, nunca logando o valor
  real) antes de um `apply` de verdade, em vez de confiar cegamente no `override_special`.

## Resultado

Implementado em 2 tasks (commits `8ce8fa0`..`b10f514`), ambas revisadas limpas de primeira. A
revisão final de branch inteiro encontrou 5 problemas, todos corrigidos numa única rodada
(commit `be704bc`), confirmados pela re-revisão sem nenhuma quebra nova Critical/Important:

- **Important:** faltava `depends_on` de `kubectl_manifest.core_server_secrets` para
  `aws_secretsmanager_secret_version.valkey_auth_token` — o `ExternalSecret` referenciava só o
  container (`aws_secretsmanager_secret...name`), não o recurso que escreve o valor de verdade.
- **Important:** o comentário de runbook em `external-secrets.tf` ainda dizia "os três containers"
  quando já existia um quarto (`valkey_auth_token`), risco real de um operador rodar
  `put-secret-value` nele por engano e causar `WRONGPASS` em toda a frota após o próximo refresh
  do ESO.
- **Minor:** um comentário alegava uma regra da AWS ("mínimo de um caractere não-alfanumérico")
  que não existe — removida.
- **Minor:** `override_special` incluía `^`, que só sobrevive como caractere literal em
  `CACHE_MASTER_URL` por `iovalkey`'s `parseURL()` chamar `decodeURIComponent()` — uma dependência
  de implementação de um client específico, não uma garantia inerente de segurança de URL.
  Removido do conjunto (`"!$^-"` → `"!$-"`).
- **Minor:** o comentário de rotação do AUTH token não mencionava a falta de hot-reload de
  `envFrom.secretRef` — complementado para espelhar o comentário equivalente do `DATABASE_URL`.

Depois da re-revisão confirmar os 5 endereçados, uma observação Minor adicional (um parágrafo do
fix duplicava um comentário pré-existente no mesmo arquivo) foi corrigida diretamente
(commit `b69c6ce`), consolidando o aviso num único lugar.

Nenhum valor de AUTH token foi impresso, logado ou exposto durante a implementação ou as revisões.

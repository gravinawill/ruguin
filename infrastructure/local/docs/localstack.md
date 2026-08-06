# LocalStack

Emulador de serviços AWS. Roda como o service `localstack` em `docker-compose.yml`.

## Para que serve

Simula a API do SES (Simple Email Service) localmente, para que o fluxo de envio/status de e-mail do produto (ex.: `apps/ses-webhook-ingestor`) possa ser desenvolvido e testado sem depender de uma conta AWS real nem enviar e-mails de verdade.

## Como funciona

- Imagem `localstack/localstack:stable`.
- `SERVICES: ses` — só o serviço SES é habilitado, não a stack inteira da AWS.
- `DEFAULT_REGION: us-east-1`.
- **Exige `LOCALSTACK_AUTH_TOKEN`** desde 2026-03-23: mesmo os recursos gratuitos (community tier) passaram a exigir autenticação. Sem essa variável definida, o container falha rápido com uma mensagem clara em vez de ficar em crash-loop.

## Como usar

1. Crie uma conta grátis em https://app.localstack.cloud e gere um Auth Token.
2. Copie `infrastructure/local/.env.example` para `infrastructure/local/.env` e cole o token lá (`.env` já está no `.gitignore` — nunca commitar).

```bash
pnpm infra:up          # sobe o localstack junto com o resto do runtime
```

- Endpoint: `localhost:4566`.
- Região: `us-east-1`.

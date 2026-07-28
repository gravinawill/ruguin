# Task 1: Monorepo scaffolding

**Depende de:** nenhuma (ponto de partida)
**Próximas tasks que dependem desta:** todas (2–11)

## Contexto

Base do repositório: workspaces do pnpm + Turborepo, config compartilhada de TypeScript, e os arquivos que toda task seguinte assume que já existem (`tsconfig.base.json` é estendido por todo `package.json` de app/pacote; `pnpm --filter <nome> <script>` e `turbo run <task>` são os comandos usados em todas as tasks).

## Arquivos

- Criar: `package.json`
- Criar: `pnpm-workspace.yaml`
- Criar: `turbo.json`
- Criar: `tsconfig.base.json`
- Criar: `.gitignore`
- Criar: `.env.example`

## Interfaces

- **Produz:** a raiz do workspace que toda task seguinte estende (`tsconfig.base.json` via `"extends"`) e onde roda (`pnpm --filter <nome> <script>`, `turbo run <task>`).

## Passos

1. **Criar o `package.json` raiz**

```json
{
  "name": "ruguin",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.1.3",
    "typescript": "^5.6.3"
  }
}
```

2. **Criar `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

3. **Criar `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

4. **Criar `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

5. **Criar `.gitignore`**

```
node_modules/
dist/
.env
*.log
.turbo/
```

6. **Criar `.env.example`**

```
DATABASE_URL=postgres://ruguin:ruguin@localhost:5432/ruguin
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SES_FROM_ADDRESS=no-reply@example.com
```

7. **Verificar que o workspace instala sem erro**

Rodar: `pnpm install`
Esperado: conclui sem erro (ainda não há pacotes no workspace, então só linka as devDependencies da raiz — isso já confirma que `pnpm-workspace.yaml` e `package.json` estão válidos).

8. **Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore .env.example pnpm-lock.yaml
git commit -m "chore: scaffold pnpm + Turborepo monorepo"
```

# syntax=docker/dockerfile:1

# Both build stages pin --platform=$BUILDPLATFORM: core-server ships zero native (.node) runtime
# dependencies (verified via `pnpm deploy --prod`), so nothing here needs to match the target
# image's architecture — only the final runner stage does. Building natively instead of under the
# target platform matters because `prisma generate` invokes a native schema-engine binary that is
# unreliable under QEMU emulation (corrupted stdout — "Unable to parse JSON [Context: getDmmf]" —
# when cross-building linux/arm64 on an amd64 runner). This also makes cross-arch builds much faster.
FROM --platform=$BUILDPLATFORM node:26.5.1-alpine AS pruner
WORKDIR /repo
# node:26 dropped the bundled corepack binary; npm is still present, so it installs corepack itself.
RUN npm install -g corepack@0.35.0 --ignore-scripts && corepack enable
COPY . .
RUN pnpm dlx turbo@2.10.8 prune @ruguin/core-server --docker

FROM --platform=$BUILDPLATFORM node:26.5.1-alpine AS builder
WORKDIR /repo
# openssl and libc6-compat are here for Prisma's schema-engine, which is native and runs on generate.
# node:26 dropped the bundled corepack binary; npm is still present, so it installs corepack itself.
RUN npm install -g corepack@0.35.0 --ignore-scripts \
  && corepack enable \
  && apk add --no-cache openssl=3.5.7-r0
COPY --from=pruner /repo/out/json/ ./
# out/json ships manifests only, no turbo.json, so the root "postinstall: pnpm run build" (turbo run
# build) has nothing to build against; strip it so the frozen install only fetches dependencies.
RUN node -e " \
  const fs = require('node:fs'); \
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  delete p.scripts.postinstall; \
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2)); \
  " \
  && pnpm install --frozen-lockfile --ignore-scripts
COPY --from=pruner /repo/out/full/ ./
# core-server's own `build` script runs directly (prisma generate && nest build), not through turbo,
# so turbo.json's `dependsOn: ["^build"]` never fires on its own here. Invoking turbo explicitly
# makes it resolve the graph and build every workspace dependency before core-server itself.
RUN pnpm exec turbo run build --filter=@ruguin/core-server \
  && pnpm --filter @ruguin/core-server deploy --prod --legacy /prod

# Estágio separado do Job PreSync do ArgoCD (infrastructure/k8s/core-server/base/migration-job.yaml)
# — `prisma migrate deploy` precisa da CLI mais o binário nativo do schema-engine, e nenhum dos dois
# está em `runner`: `runner` copia só `/prod`, que `pnpm deploy --prod` monta filtrando pelo `files`
# de package.json (`["dist"]` — nunca inclui `prisma/`), e `prisma` é devDependency, então some do
# `/prod` de qualquer forma.
#
# Não estende `builder`: aquele estágio é fixado em $BUILDPLATFORM pra `prisma generate` não rodar
# sob QEMU (comentário acima) — mas o binário do schema-engine que `migrate deploy` usa em runtime é
# específico de arquitetura, o oposto do que `builder` garante. Sem override de `--platform` aqui,
# igual a `runner` abaixo, pro buildx resolver a arquitetura certa por plataforma alvo — o mesmo
# padrão que o `apk add` do tini em `runner` já usa com sucesso em build multi-arch.
FROM node:26.5.1-alpine AS migrator
# Mesmo par UID/GID 1001 do `runner` abaixo — não porque precisa bater (são imagens diferentes,
# sem volume compartilhado), mas porque o Job (migration-job.yaml) roda com runAsNonRoot: true, que
# exige um USER numérico de verdade na imagem ou o pod não sobe (CreateContainerConfigError).
RUN apk add --no-cache openssl=3.5.7-r0 \
  && addgroup -g 1001 -S nodejs \
  && adduser -u 1001 -S nestjs -G nodejs
WORKDIR /app
# Install isolado (sem copiar o package.json do core-server) pra não resolver as ~60 dependências
# não relacionadas (@nestjs/* etc.) que estão lá — só a CLI e sua dependência nativa
# (@prisma/engines, baixada pelo postinstall do próprio pacote). Versão travada manualmente, mesmo
# padrão que este Dockerfile já usa pra openssl/tini acima: atualizar esse número junto de qualquer
# bump de prisma/@prisma/client em apps/core-server/package.json.
# npm install roda como root (node_modules ainda não existe pro WORKDIR ser dono de ninguém); o
# chown devolve a árvore pro usuário não-root antes do COPY --chown abaixo e do USER no final.
RUN npm install prisma@7.9.1 && chown -R nestjs:nodejs /app
COPY --from=builder --chown=nestjs:nodejs /repo/apps/core-server/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /repo/apps/core-server/prisma.config.ts ./prisma.config.ts
USER 1001:1001
ENTRYPOINT ["node_modules/.bin/prisma"]
CMD ["migrate", "deploy"]

FROM node:26.5.1-alpine AS runner
# tini is PID 1 because main.ts enables shutdown hooks: without it, SIGTERM would kill the process
# with the Prisma connection still open instead of closing it.
# UID/GID 1001 pinned explicitly (not left to `-S`'s default allocation) so USER below can be
# numeric — Kubernetes securityContext.runAsNonRoot and similar host-level checks can't resolve a
# username, only a uid.
RUN apk add --no-cache tini=0.19.0-r3 \
  && addgroup -g 1001 -S nodejs \
  && adduser -u 1001 -S nestjs -G nodejs
WORKDIR /app
COPY --from=builder --chown=nestjs:nodejs /prod ./
USER 1001:1001
ENV NODE_ENV=production
EXPOSE 3333
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]

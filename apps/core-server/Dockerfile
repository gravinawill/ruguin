# syntax=docker/dockerfile:1

FROM node:26.5.1-alpine AS pruner
WORKDIR /repo
# node:26 dropped the bundled corepack binary; npm is still present, so it installs corepack itself.
RUN npm install -g corepack@latest && corepack enable
COPY . .
RUN pnpm dlx turbo@2.10.8 prune @ruguin/core-server --docker

FROM node:26.5.1-alpine AS builder
WORKDIR /repo
# openssl e libc6-compat existem para o schema-engine do Prisma, que é nativo e roda no generate.
# node:26 dropped the bundled corepack binary; npm is still present, so it installs corepack itself.
RUN npm install -g corepack@latest && corepack enable && apk add --no-cache openssl libc6-compat
COPY --from=pruner /repo/out/json/ ./
# out/json ships manifests only, no turbo.json, so the root "postinstall: pnpm run build" (turbo run
# build) has nothing to build against; strip it so the frozen install only fetches dependencies.
RUN node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.scripts.postinstall;fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
# @ruguin/cache is consumed via its built ./dist/index.mjs (tsdown), unlike the other workspace
# deps which core-server imports as raw TS; `--filter core-server build` alone never builds it.
RUN pnpm --filter @ruguin/cache build
RUN pnpm --filter @ruguin/core-server build
RUN pnpm --filter @ruguin/core-server deploy --prod --legacy /prod

FROM node:26.5.1-alpine AS runner
# tini é PID 1 porque main.ts habilita shutdown hooks: sem ele o SIGTERM encerra o processo com a
# conexão do Prisma aberta em vez de fechá-la.
RUN apk add --no-cache tini \
  && addgroup -S nodejs \
  && adduser -S nestjs -G nodejs
WORKDIR /app
COPY --from=builder --chown=nestjs:nodejs /prod ./
USER nestjs
ENV NODE_ENV=production
EXPOSE 3333
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]

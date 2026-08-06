# Conduktor

UI web para o Kafka. Roda como o service `conduktor` em `docker-compose.tools.yml`.

## Para que serve

Permite inspecionar tópicos, mensagens, consumer groups e configurações do [Kafka](kafka.md) local pelo navegador, sem precisar de CLI (`kafka-console-consumer`, etc.) para depurar o que está passando pelo barramento de eventos.

## Como funciona

- Imagem `conduktor/conduktor-console:latest`.
- Depende de `postgres` e `kafka` estarem `healthy` antes de subir.
- Guarda seu próprio estado no database `conduktor-console`, dentro do mesmo container Postgres do runtime (criado automaticamente por `postgres-init/01-create-tooling-databases.sh` no primeiro boot) — não sobe um Postgres dedicado.
- Conecta no Kafka pelo listener `INTERNAL` (`kafka:29092`), porque o Conduktor roda como outro container na mesma rede do compose e não consegue resolver `localhost` de volta para o container do Kafka.
- Senha admin fixada via env var: a imagem rejeita senhas fracas (mínimo 8 caracteres, maiúscula+minúscula+dígito+símbolo).

## Como usar

```bash
pnpm infra:tools:up    # sobe runtime + ferramentas, incluindo o conduktor
```

- Endereço: http://localhost:8080
- Login: `admin@ruguin.local` / `Ruguin#Dev1`
- O cluster `local` já vem pré-cadastrado apontando para `kafka:29092` — não precisa configurar nada na primeira vez que abrir.

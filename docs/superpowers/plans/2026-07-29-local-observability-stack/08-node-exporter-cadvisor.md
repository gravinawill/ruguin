# Task 8: `node_exporter` + cAdvisor (métricas de host e container)

**Depende de:** Task 5 (Prometheus já referencia estes alvos)
**Próximas tasks que dependem desta:** 10 (dashboards de host/containers)

## Contexto

`node_exporter` mede o host (CPU, memória, disco); cAdvisor mede por container (quanto cada um dos 10+ containers desta stack está consumindo). Com Docker Desktop/OrbStack no macOS, ambos rodam dentro da VM Linux do Docker — as métricas refletem a VM, não o macOS diretamente, mas é exatamente onde os containers rodam de fato, então é o que importa.

## Arquivos

- Modificar: `infrastructure/local/docker-compose.observability.yml`

## Interfaces

- **Produz:** `node-exporter:9100/metrics` e `cadvisor:8080/metrics` — alvos já configurados no `prometheus.yml` da Task 5 sob os jobs `node` e `cadvisor`; usados pela Task 10 (dashboards).

## Passos

- [ ] **Passo 1: Adicionar os dois serviços em `docker-compose.observability.yml`**

```yaml
  node-exporter:
    image: prom/node-exporter:latest
    restart: unless-stopped
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    logging: *loki-logging

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    restart: unless-stopped
    privileged: true
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    logging: *loki-logging
```

- [ ] **Passo 2: Subir e verificar**

```bash
docker compose -f infrastructure/local/docker-compose.yml -f infrastructure/local/docker-compose.observability.yml up -d node-exporter cadvisor
sleep 10
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"node".\{0,20\}"health":"up"'
curl -s http://localhost:9090/api/v1/targets | grep -o '"job":"cadvisor".\{0,20\}"health":"up"'
```
Esperado: ambos os jobs aparecem com `"health":"up"`. Se `cadvisor` não subir no macOS (erro relacionado a `/sys` ou `/var/lib/docker` não existir do jeito esperado dentro da VM do Docker Desktop/OrbStack), documentar o erro exato — é uma limitação conhecida de cAdvisor fora de Linux nativo, não um bug desta task.

- [ ] **Passo 3: Commit**

```bash
git add infrastructure/local/docker-compose.observability.yml
git commit -m "feat(observability): add node_exporter and cAdvisor for host/container metrics"
```

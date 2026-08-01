# Core Server

## Environment Variables

| Variable                                | Required                | Description                                                                                                                |
| --------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DOCS_USERNAME`                         | yes                     | Basic Auth username protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `DOCS_PASSWORD`                         | yes                     | Basic Auth password protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `PORT`                                  | no (default `3000`)     | HTTP port the app listens on.                                                                                              |
| `LOG_LEVEL`                             | no (default `info`)     | Pino log level.                                                                                                            |
| `NODE_ENV`                              | no                      | `production` disables the `pino-pretty` transport.                                                                         |
| `CACHE_PREFIX`                          | yes                     | Prefix of every physical cache key. No default — the app does not boot without it.                                         |
| `CACHE_DRIVER`                          | no (default `memory`)   | `valkey`, `memory` or `noop`.                                                                                              |
| `CACHE_MASTER_URL`                      | conditional             | Required when `CACHE_DRIVER=valkey`.                                                                                       |
| `CACHE_REPLICA_URLS`                    | no (default empty)      | Comma-separated; eventual reads round-robin across them.                                                                   |
| `CACHE_DEFAULT_TTL_MS`                  | no (default `300000`)   | TTL applied when the call site declares none.                                                                              |
| `CACHE_JITTER_RATIO`                    | no (default `0.1`)      | Spread applied to the TTL, against a mass expiry.                                                                          |
| `CACHE_NEGATIVE_TTL_MS`                 | no (default `30000`)    | TTL of `getOrSet`'s negative cache.                                                                                        |
| `CACHE_NS_VERSION_LOCAL_TTL_MS`         | no (default `5000`)     | Ceiling on how long an invalidation may not have reached this instance.                                                    |
| `CACHE_DEFAULT_CONSISTENCY`             | no (default `eventual`) | `eventual` or `strong`.                                                                                                    |
| `CACHE_INVALIDATION_BROADCAST`          | no (default `true`)     | Pub/Sub that shortens the invalidation window.                                                                             |
| `CACHE_OPERATION_TIMEOUT_MS`            | no (default `500`)      | Deadline of one command; the lock TTL is ten times this.                                                                   |
| `CACHE_BREAKER_FAILURE_THRESHOLD`       | no (default `5`)        | Consecutive failures that open the circuit.                                                                                |
| `CACHE_BREAKER_RESET_TIMEOUT_MS`        | no (default `10000`)    | Wait before the circuit tries again.                                                                                       |
| `CACHE_REPLICATION_LAG_THRESHOLD_BYTES` | no (default `1048576`)  | Lag above which health reports `degraded`.                                                                                 |

These are the only variables the app reads. `configure-app.ts` imports `@ruguin/env/docs` and `app.module.ts`
imports `@ruguin/env/cache`, rather than the `@ruguin/env` barrel: the barrel evaluates every sibling schema at
import time, which would make `core-server` require the database, message-broker and token-provider variables it
does not use.

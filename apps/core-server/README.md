# Core Server

## Environment Variables

| Variable        | Required            | Description                                                                                                                |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DOCS_USERNAME` | yes                 | Basic Auth username protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `DOCS_PASSWORD` | yes                 | Basic Auth password protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `PORT`          | no (default `3000`) | HTTP port the app listens on.                                                                                              |
| `LOG_LEVEL`     | no (default `info`) | Pino log level.                                                                                                            |
| `NODE_ENV`      | no                  | `production` disables the `pino-pretty` transport.                                                                         |

These are the only variables the app reads. `configure-app.ts` imports `@ruguin/env/docs` rather than the
`@ruguin/env` barrel on purpose: the barrel evaluates every sibling schema at import time, which would make
`core-server` require the cache, database, message-broker and token-provider variables it does not use.

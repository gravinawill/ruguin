# Core Server

## Environment Variables

| Variable        | Required            | Description                                                                                                                |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DOCS_USERNAME` | yes                 | Basic Auth username protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `DOCS_PASSWORD` | yes                 | Basic Auth password protecting `/docs` and `/docs-json`. Required in every environment — the app fails to boot without it. |
| `PORT`          | no (default `3000`) | HTTP port the app listens on.                                                                                              |

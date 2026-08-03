import { createTracingSdk } from './shared/infrastructure/tracing/create-tracing-sdk'

createTracingSdk(process.env).start()

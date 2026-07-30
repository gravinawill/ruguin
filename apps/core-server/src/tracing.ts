import { createTracingSdk } from './tracing/create-tracing-sdk'

createTracingSdk(process.env).start()

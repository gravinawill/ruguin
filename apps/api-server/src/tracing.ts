import { createTracingSdk } from './tracing/create-tracing-sdk.js'

createTracingSdk(process.env).start()

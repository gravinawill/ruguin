import type { Options } from 'k6/options'

import { check, sleep } from 'k6'
import http from 'k6/http'

/*
 * Targets the api-server's Terminus health check. Run the api-server yourself first
 * (`pnpm --filter @ruguin/api-server start:dev`), then `pnpm infra:load-test:api-server`.
 * Override with K6_TARGET_URL to point at a different host/port.
 */
// eslint-disable-next-line unicorn/prefer-https -- local Docker network, no TLS available
const TARGET_URL: string = __ENV.K6_TARGET_URL ?? 'http://host.docker.internal:3000/health'

export const options: Options = {
  vus: 5,
  duration: '10s'
}

export default function test(): void {
  const result = http.get(TARGET_URL)
  check(result, { 'status is 200': (response: unknown) => response.status === 200 })
  sleep(1)
}

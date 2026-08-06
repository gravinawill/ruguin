import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses'
import { Test, type TestingModule } from '@nestjs/testing'
import { awsENV, testSeedENV } from '@ruguin/env'
import { EMAIL_STATUS_UPDATED_TOPIC } from '@ruguin/event-schemas'
import { MESSAGE_CONSUMER_PORT, MessageBrokerModule, type MessageConsumerPort } from '@ruguin/message-broker'
import { success } from '@ruguin/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createMessageBrokerModuleOptions } from '../shared/infrastructure/message-broker/message-broker-module-options'

const CORE_SERVER_PORT = 3333
const DISPATCH_WORKER_PORT = 3334
const HEALTH_POLL_INTERVAL_MS = 500
const HEALTH_POLL_TIMEOUT_MS = 30_000
const BOOT_TIMEOUT_MS = HEALTH_POLL_TIMEOUT_MS + 15_000
const STATUS_EVENT_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 60_000
/*
 * Vitest's hookTimeout default (10_000ms) is too short here: afterAll closes a real Kafka
 * consumer, then SIGTERMs two real child process groups concurrently (Promise.all) — each with
 * its own 5000ms force-kill grace period (killApp). 20s leaves comfortable headroom over that
 * worst case.
 */
const SHUTDOWN_TIMEOUT_MS = 20_000

type SpawnedApp = Readonly<{
  packageName: string
  process: ChildProcessWithoutNullStreams
  output: string[]
}>

/*
 * pnpm --filter resolves the target package from anywhere inside the workspace, so this doesn't
 * need repo-root cwd math — process.cwd() during `vitest run --project pipeline-e2e` is already
 * apps/core-server/, itself inside the workspace. shell: true because pnpm's own binary may be a
 * shell-wrapped shim depending on how it was installed — the two args passed are both hardcoded
 * package names below, never interpolated user input.
 *
 * detached: true, paired with killApp() signaling the negative pid below, is load-bearing, not
 * cosmetic: `pnpm --filter <pkg> start` forks through several layers (this shell → the pnpm CLI →
 * pnpm's own inner shell → the app's real `node ...` process), and child.kill() only ever signals
 * the single top pid we hold a handle to. Confirmed against this repo's own two start scripts:
 * dispatch-worker's plain `node dist/main.js` happens to forward SIGTERM through every layer, but
 * core-server's `node --import ./dist/tracing.js dist/main.js` does not — its real server process
 * survived a SIGTERM to the top pid and kept the port bound, orphaned, across every later run
 * until killed by hand. detached: true makes this top pid the leader of a new process group that
 * every descendant inherits, so signaling -pid (the group) reaches all of them regardless of which
 * layer would otherwise swallow it.
 */
function spawnApp(packageName: string): SpawnedApp {
  const output: string[] = []
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- static command, no interpolated input; `pnpm --filter` is the intended way to run a workspace package's own script.
  const child = spawn('pnpm', ['--filter', packageName, 'start'], {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    detached: true,
    stdio: 'pipe'
  })
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk.toString())
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output.push(chunk.toString())
  })
  return { packageName, process: child, output }
}

async function waitForHealthy(app: SpawnedApp, port: number): Promise<void> {
  try {
    await vi.waitUntil(
      async () => {
        try {
          const response = await fetch(`http://localhost:${port}/health`)
          return response.status === 200
        } catch {
          return false
        }
      },
      { timeout: HEALTH_POLL_TIMEOUT_MS, interval: HEALTH_POLL_INTERVAL_MS }
    )
  } catch (error) {
    // The buffered stdout/stderr is the only diagnostic for why boot never reached a healthy state.
    throw new Error(`${app.packageName} never became healthy on port ${port}:\n${app.output.join('')}`, {
      cause: error
    })
  }
}

/*
 * Signals the negative pid — the whole process group spawnApp's detached: true created — not
 * app.process.kill(signal), which only reaches the single top pid (see spawnApp's comment on why
 * that leaves the real server process orphaned, still bound to its port, for core-server).
 * Accepts undefined so afterAll can call it unconditionally even when beforeAll threw before
 * spawnApp ran (coreServer/dispatchWorker never assigned) — a no-op then, nothing to kill.
 */
function killApp(app: SpawnedApp | undefined): Promise<void> {
  if (app === undefined) return Promise.resolve()

  return new Promise((resolve) => {
    const pid = app.process.pid
    if (pid === undefined) {
      resolve()
      return
    }

    const forceKillTimer = setTimeout(() => {
      process.kill(-pid, 'SIGKILL')
    }, 5000)
    app.process.once('exit', () => {
      clearTimeout(forceKillTimer)
      resolve()
    })
    process.kill(-pid, 'SIGTERM')
  })
}

describe('Email send pipeline end to end (core-server + dispatch-worker as real processes)', () => {
  /*
   * All three start undefined and are only assigned partway through beforeAll (SES verify, then
   * spawnApp x2, then Test.createTestingModule().compile()/.init()) — afterAll must tolerate
   * beforeAll throwing at any point in that sequence, or a real spawned process (coreServer/
   * dispatchWorker) is left orphaned, still bound to its port, exactly like the bug spawnApp's
   * detached:true / killApp's process-group kill already fixes for the happy-path shutdown.
   */
  let coreServer: SpawnedApp | undefined
  let dispatchWorker: SpawnedApp | undefined
  let moduleReference: TestingModule | undefined
  let consumer: MessageConsumerPort

  beforeAll(async () => {
    /*
     * prisma/seed.ts writes SenderIdentity.verifiedAt directly, without ever calling the real SES
     * CreateEmailIdentity (design spec decision 9 of the SenderIdentity plan) — LocalStack has no
     * record of this identity, and SesEmailSender (apps/dispatch-worker/.../ses-email-sender.ts)
     * uses it as the SendEmailCommand's Source. Verify it here first, the same way
     * dispatch-email.e2e.ts (dispatch-worker) pre-verifies its own hardcoded address.
     */
    const sesClient = new SESClient({
      region: awsENV.AWS_REGION,
      ...(awsENV.AWS_ENDPOINT_URL !== undefined && { endpoint: awsENV.AWS_ENDPOINT_URL }),
      ...(awsENV.AWS_ACCESS_KEY_ID !== undefined &&
        awsENV.AWS_SECRET_ACCESS_KEY !== undefined && {
          credentials: { accessKeyId: awsENV.AWS_ACCESS_KEY_ID, secretAccessKey: awsENV.AWS_SECRET_ACCESS_KEY }
        })
    })
    await sesClient.send(
      new VerifyEmailIdentityCommand({ EmailAddress: testSeedENV.TEST_SEEDED_SENDER_IDENTITY_EMAIL })
    )

    coreServer = spawnApp('@ruguin/core-server')
    dispatchWorker = spawnApp('@ruguin/dispatch-worker')
    await Promise.all([
      waitForHealthy(coreServer, CORE_SERVER_PORT),
      waitForHealthy(dispatchWorker, DISPATCH_WORKER_PORT)
    ])

    /*
     * A standalone MessageBrokerModule host, not either app's AppModule — this test only needs a
     * Kafka consumer to observe email.status.updated from the outside, exactly like a third-party
     * client would. createMessageBrokerModuleOptions() is core-server's own options builder,
     * reused so brokers/clientId/ssl match what the real core-server process above uses.
     */
    moduleReference = await Test.createTestingModule({
      imports: [MessageBrokerModule.forRoot(createMessageBrokerModuleOptions())]
    }).compile()
    await moduleReference.init()
    consumer = moduleReference.get<MessageConsumerPort>(MESSAGE_CONSUMER_PORT)
  }, BOOT_TIMEOUT_MS)

  afterAll(async () => {
    try {
      await moduleReference?.close()
    } finally {
      await Promise.all([killApp(coreServer), killApp(dispatchWorker)])
    }
  }, SHUTDOWN_TIMEOUT_MS)

  it(
    'sends an email through POST /v1/emails and observes email.status.updated with status=sent',
    async () => {
      const statusEvents: unknown[] = []
      await consumer.subscribe({
        topic: EMAIL_STATUS_UPDATED_TOPIC,
        groupId: `pipeline-e2e-${Date.now()}`,
        onMessage: (message) => {
          statusEvents.push(message.payload)
          return Promise.resolve(success(undefined))
        }
      })

      const response = await fetch(`http://localhost:${CORE_SERVER_PORT}/v1/emails`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testSeedENV.TEST_SEEDED_API_KEY}`
        },
        body: JSON.stringify({
          to: 'pipeline-e2e-recipient@example.com',
          templateId: testSeedENV.TEST_SEEDED_TEMPLATE_ID,
          variables: { name: 'Pipeline E2E' }
        })
      })

      expect(response.status).toBe(202)
      const body = (await response.json()) as { id: string; status: string }
      expect(body.status).toBe('queued')
      expect(body.id.length).toBeGreaterThan(0)

      await vi.waitUntil(() => statusEvents.some((event) => (event as { emailId: string }).emailId === body.id), {
        timeout: STATUS_EVENT_TIMEOUT_MS,
        interval: 200
      })

      expect(statusEvents).toContainEqual(
        expect.objectContaining({ emailId: body.id, status: 'sent', sesMessageId: expect.any(String) })
      )
    },
    TEST_TIMEOUT_MS
  )
})

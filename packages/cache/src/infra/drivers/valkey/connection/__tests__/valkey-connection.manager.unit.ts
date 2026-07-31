import { describe, expect, it } from 'vitest'

import { pickReadyReplica } from '../valkey-connection.manager'

const replica = (input: { host: string; status: string }): { client: { status: string }; host: string } => ({
  client: { status: input.status },
  host: input.host
})

describe('pickReadyReplica', () => {
  it('answers null when no replica is configured, so the caller falls back to the master', () => {
    expect(pickReadyReplica({ cursor: 0, replicas: [] })).toBeNull()
  })

  it('walks the list in order as the cursor advances', () => {
    const replicas = [replica({ host: 'a:6379', status: 'ready' }), replica({ host: 'b:6379', status: 'ready' })]

    expect(pickReadyReplica({ cursor: 0, replicas })?.host).toBe('a:6379')
    expect(pickReadyReplica({ cursor: 1, replicas })?.host).toBe('b:6379')
    expect(pickReadyReplica({ cursor: 2, replicas })?.host).toBe('a:6379')
  })

  it('skips a replica that is not ready instead of routing a command at it', () => {
    const replicas = [replica({ host: 'a:6379', status: 'reconnecting' }), replica({ host: 'b:6379', status: 'ready' })]

    expect(pickReadyReplica({ cursor: 0, replicas })?.host).toBe('b:6379')
  })

  /*
   * Null rather than "the least bad option": with every replica down the read has to go to the
   * master, and that is a routing decision the manager makes — not a command that fails first and
   * gets retried somewhere else.
   */
  it('answers null when every replica is down', () => {
    const replicas = [replica({ host: 'a:6379', status: 'close' }), replica({ host: 'b:6379', status: 'reconnecting' })]

    expect(pickReadyReplica({ cursor: 0, replicas })).toBeNull()
  })
})

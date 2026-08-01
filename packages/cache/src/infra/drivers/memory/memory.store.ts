type Expirable = Readonly<{ expiresAt: number | null }>

type StoredValue = Expirable & Readonly<{ serialized: string }>
type StoredCounter = Expirable & { value: number }
type StoredLock = Readonly<{ token: string; expiresAt: number }>
type StoredScores = Expirable & Readonly<{ members: Map<string, number> }>

const INITIAL_VERSION = 1

const isExpired = (entry: Expirable): boolean => entry.expiresAt !== null && Date.now() >= entry.expiresAt

const expiryFrom = (ttlInMs: number | undefined): number | null => (ttlInMs === undefined ? null : Date.now() + ttlInMs)

export class MemoryStore {
  private readonly values: Map<string, StoredValue> = new Map<string, StoredValue>()
  private readonly counters: Map<string, StoredCounter> = new Map<string, StoredCounter>()
  private readonly locks: Map<string, StoredLock> = new Map<string, StoredLock>()
  private readonly scores: Map<string, StoredScores> = new Map<string, StoredScores>()
  private readonly versions: Map<string, number> = new Map<string, number>()

  public setValue(input: { key: string; serialized: string; ttlInMs?: number }): void {
    this.values.set(input.key, { serialized: input.serialized, expiresAt: expiryFrom(input.ttlInMs) })
  }

  public getValue(input: { key: string }): string | null {
    const entry: StoredValue | undefined = this.values.get(input.key)
    if (entry === undefined) return null

    if (isExpired(entry)) {
      this.values.delete(input.key)
      return null
    }

    return entry.serialized
  }

  public deleteValue(input: { key: string }): boolean {
    const wasPresent: boolean = this.getValue({ key: input.key }) !== null
    this.values.delete(input.key)

    return wasPresent
  }

  public setValueIfAbsent(input: { key: string; serialized: string; ttlInMs?: number }): boolean {
    if (this.getValue({ key: input.key }) !== null) return false

    this.setValue(input)

    return true
  }

  public incrementCounter(input: { key: string; by: number; ttlInMs?: number }): number {
    const entry: StoredCounter | undefined = this.counters.get(input.key)

    if (entry === undefined || isExpired(entry)) {
      const created: StoredCounter = { value: input.by, expiresAt: expiryFrom(input.ttlInMs) }
      this.counters.set(input.key, created)

      return created.value
    }

    /*
     * The window is anchored to the first increment; renewing it here would make a
     * fixed-window rate limiter never reset under sustained traffic.
     */
    entry.value += input.by

    return entry.value
  }

  public getCounter(input: { key: string }): number {
    const entry: StoredCounter | undefined = this.counters.get(input.key)
    if (entry === undefined) return 0

    if (isExpired(entry)) {
      this.counters.delete(input.key)
      return 0
    }

    return entry.value
  }

  public acquireLock(input: { key: string; token: string; ttlInMs: number }): boolean {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held !== undefined && Date.now() < held.expiresAt) return false

    this.locks.set(input.key, { token: input.token, expiresAt: Date.now() + input.ttlInMs })

    return true
  }

  public releaseLock(input: { key: string; token: string }): 'released' | 'not-owned' {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held === undefined || Date.now() >= held.expiresAt) return 'not-owned'
    if (held.token !== input.token) return 'not-owned'

    this.locks.delete(input.key)

    return 'released'
  }

  public extendLock(input: { key: string; token: string; ttlInMs: number }): boolean {
    const held: StoredLock | undefined = this.locks.get(input.key)

    if (held === undefined || Date.now() >= held.expiresAt) return false
    if (held.token !== input.token) return false

    this.locks.set(input.key, { token: held.token, expiresAt: Date.now() + input.ttlInMs })

    return true
  }

  public setScore(input: { key: string; member: string; score: number; ttlInMs?: number }): boolean {
    const members: Map<string, number> = this.membersOf({
      key: input.key,
      ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
    })
    const isNewMember = !members.has(input.member)

    members.set(input.member, input.score)

    return isNewMember
  }

  public incrementScore(input: { key: string; member: string; by: number; ttlInMs?: number }): number {
    const members: Map<string, number> = this.membersOf({
      key: input.key,
      ...(input.ttlInMs !== undefined && { ttlInMs: input.ttlInMs })
    })
    const next: number = (members.get(input.member) ?? 0) + input.by

    members.set(input.member, next)

    return next
  }

  public getScore(input: { key: string; member: string }): number | null {
    return this.liveMembers({ key: input.key })?.get(input.member) ?? null
  }

  public getRankAndTotal(input: { key: string; member: string }): { rank: number | null; total: number } {
    const ordered: Array<{ member: string; score: number }> = this.ordered({ key: input.key })
    const index: number = ordered.findIndex((entry) => entry.member === input.member)

    return { rank: index === -1 ? null : index + 1, total: ordered.length }
  }

  public getTopScores(input: {
    key: string
    limit: number
    offset?: number
  }): Array<{ member: string; score: number }> {
    const offset: number = input.offset ?? 0

    return this.ordered({ key: input.key }).slice(offset, offset + input.limit)
  }

  public removeScore(input: { key: string; member: string }): boolean {
    return this.liveMembers({ key: input.key })?.delete(input.member) ?? false
  }

  public countScores(input: { key: string }): number {
    return this.liveMembers({ key: input.key })?.size ?? 0
  }

  public bumpVersion(input: { namespace: string }): number {
    const next: number = this.getVersion({ namespace: input.namespace }) + 1
    this.versions.set(input.namespace, next)

    return next
  }

  public getVersion(input: { namespace: string }): number {
    return this.versions.get(input.namespace) ?? INITIAL_VERSION
  }

  public clear(): void {
    this.values.clear()
    this.counters.clear()
    this.locks.clear()
    this.scores.clear()
    this.versions.clear()
  }

  private membersOf(input: { key: string; ttlInMs?: number }): Map<string, number> {
    const live: Map<string, number> | null = this.liveMembers({ key: input.key })
    if (live !== null) return live

    const created: StoredScores = { members: new Map<string, number>(), expiresAt: expiryFrom(input.ttlInMs) }
    this.scores.set(input.key, created)

    return created.members
  }

  private liveMembers(input: { key: string }): Map<string, number> | null {
    const entry: StoredScores | undefined = this.scores.get(input.key)
    if (entry === undefined) return null

    if (isExpired(entry)) {
      this.scores.delete(input.key)
      return null
    }

    return entry.members
  }

  private ordered(input: { key: string }): Array<{ member: string; score: number }> {
    const members: Map<string, number> | null = this.liveMembers({ key: input.key })
    if (members === null) return []

    /*
     * Byte order on the tiebreak, not locale order: Valkey orders equal ZSET scores
     * lexicographically by member bytes, and `'B'.localeCompare('a')` is 1 while `'B' < 'a'`
     * is true. Using localeCompare here would make the memory driver disagree with Valkey.
     */
    return [...members]
      .map(([member, score]) => ({ member, score }))
      .toSorted((left, right) => right.score - left.score || (left.member < right.member ? -1 : 1))
  }
}

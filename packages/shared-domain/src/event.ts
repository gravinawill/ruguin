import { ID } from './value-objects/index.ts'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type DeepReadonly<T> =
  T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value

  Object.freeze(value)

  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }

  return value
}

export class Event<TPayload extends JsonValue> {
  readonly id: ID
  readonly name: string
  readonly payload: DeepReadonly<TPayload>
  readonly #occurredAtEpoch: number

  private constructor(input: { id: ID; name: string; payload: TPayload; occurredAtEpoch: number }) {
    this.id = input.id
    this.name = input.name
    this.payload = deepFreeze(input.payload) as DeepReadonly<TPayload>
    this.#occurredAtEpoch = input.occurredAtEpoch
    Object.freeze(this)
  }

  /*
   * A getter, not a stored Date: exposing the field directly would let a caller mutate the
   * instance's notion of when it occurred via `event.occurredAt.setTime(...)` — Object.freeze(this)
   * does not reach into a Date object referenced by a frozen property. Returning a fresh Date from
   * the private epoch on every read closes that without a caller-observable difference.
   */
  get occurredAt(): Date {
    return new Date(this.#occurredAtEpoch)
  }

  public static create<TPayload extends JsonValue>(name: string, payload: TPayload): Event<TPayload> {
    const generated = ID.generate({ valueObjectName: 'Event' })

    /*
     * ID.generate() only fails if UUID generation itself throws, which does not happen in
     * practice — treated as a bug rather than an expected Either failure.
     */
    if (generated.isFailure()) {
      throw new Error(`Failed to generate an id for event "${name}": ${generated.value.message}`)
    }

    return new Event({ id: generated.value.idGenerated, name, occurredAtEpoch: Date.now(), payload })
  }
}

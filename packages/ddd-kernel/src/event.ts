import { ID } from './value-objects/index.ts'

export class Event<TPayload> {
  readonly id: ID
  readonly name: string
  readonly payload: TPayload
  readonly occurredAt: Date

  private constructor(input: { id: ID; name: string; payload: TPayload; occurredAt: Date }) {
    this.id = input.id
    this.name = input.name
    this.payload = input.payload
    this.occurredAt = input.occurredAt
    Object.freeze(this)
  }

  public static create<TPayload>(name: string, payload: TPayload): Event<TPayload> {
    const generated = ID.generate({ valueObjectName: 'Event' })

    /*
     * ID.generate() only fails if UUID generation itself throws, which does not happen in
     * practice — treated as a bug rather than an expected Either failure.
     */
    if (generated.isFailure()) {
      throw new Error(`Failed to generate an id for event "${name}": ${generated.value.message}`)
    }

    return new Event({ id: generated.value.idGenerated, name, occurredAt: new Date(), payload })
  }
}

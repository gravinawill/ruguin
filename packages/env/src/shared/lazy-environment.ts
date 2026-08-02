export function lazyEnvironment<T extends object>(build: () => T): T {
  let resolved: T | undefined

  const load = (): T => {
    resolved ??= build()

    return resolved
  }

  return new Proxy({} as T, {
    get: (_target, property, receiver: unknown) => Reflect.get(load(), property, receiver),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(load(), property)

      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
    has: (_target, property) => Reflect.has(load(), property),
    ownKeys: () => Reflect.ownKeys(load())
  })
}

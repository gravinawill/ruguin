import 'reflect-metadata'

import { Injectable } from '@nestjs/common'
import { describe, expect, it } from 'vitest'

class Dependency {}

@Injectable()
class ServiceUnderTest {
  constructor(private readonly dependency: Dependency) {}

  getDependency(): Dependency {
    return this.dependency
  }
}

describe('SWC decorator metadata', () => {
  it('emits design:paramtypes for constructor-injected dependencies', () => {
    // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties -- reflect-metadata polyfill API, not the native Reflect
    const parameterTypes = Reflect.getMetadata('design:paramtypes', ServiceUnderTest) as unknown[]

    expect(parameterTypes).toEqual([Dependency])
  })
})

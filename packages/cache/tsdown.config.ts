import { defineConfig } from 'tsdown'

/*
 * Only the NestJS adapter is built. The rest of the package ships as raw TypeScript, like every
 * other package here — Node strips its types at load and runs it directly.
 *
 * That trick stops working the moment a file uses a decorator. `@Module()` and `@Injectable()` are
 * syntax V8 does not implement, and stripping types cannot rewrite them, so a raw `cache.module.ts`
 * dies at load with `SyntaxError: Invalid or unexpected token`. Only this entrypoint needs the
 * compile step, so only this entrypoint gets one.
 *
 * `@ruguin/cache` is external on purpose. Bundling the root would give the adapter its own copies of
 * CacheProviderFacade and friends, and a class imported from the barrel would no longer be the class
 * the module instantiates — the kind of duplication that surfaces as an `instanceof` that quietly
 * answers false.
 */
export default defineConfig({
  entry: ['src/nestjs/index.ts'],
  outDir: 'dist/nestjs',
  format: ['esm'],
  dts: true,
  deps: { neverBundle: ['@ruguin/cache'] },
  unbundle: false
})

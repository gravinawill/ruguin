import { defineConfig } from 'tsdown'

/*
 * The whole package is built, not just the NestJS adapter.
 *
 * Shipping raw TypeScript stops working the moment a file uses a decorator: `@Module()` and
 * `@Injectable()` are syntax V8 does not implement, and type stripping cannot rewrite them, so a
 * raw cache.module.ts dies at load with `SyntaxError: Invalid or unexpected token`. Since the
 * barrel now re-exports nestjs/, that syntax reaches the barrel, and the barrel has to be compiled.
 *
 * One entry, not two: a second entry importing the barrel would get its own copies of
 * CacheProviderFacade and friends, and a class imported from the barrel would no longer be the
 * class the module instantiates — duplication that surfaces as an `instanceof` quietly answering
 * false.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  unbundle: false
})

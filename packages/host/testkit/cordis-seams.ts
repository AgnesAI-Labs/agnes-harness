import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { DYNAMIC_SEAM_NAMES, normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { PackageModule } from '../src/assemble/packages.js'

const TEST_PRESET_CONFIG = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'host-test',
    validate(value: unknown) {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: 'expected object' }] }
    },
  }),
})

function testSeamPlugin(name: (typeof DYNAMIC_SEAM_NAMES)[number], factory: (ctx: never) => unknown) {
  const service = `seam:${name}`
  return defineAgnesPlugin({
    Config: TEST_PRESET_CONFIG,
    inject: ['host:seam-init'],
    provide: service,
    async apply(ctx: Context, config: Readonly<Record<string, unknown>>) {
      const values = ctx as unknown as Record<string, unknown>
      const rawInit = (
        values['host:seam-init'] as () => {
          seamTimeoutMs?: number
          profile: Readonly<Record<string, unknown>> & { preset: Record<string, unknown> }
        }
      )()
      const init = {
        ...rawInit,
        profile: Object.freeze({ ...rawInit.profile, preset: config }),
      }
      let implementation: unknown
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        implementation = await Promise.race([
          factory(init as never),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`seam ${name} timed out after ${init.seamTimeoutMs ?? 30_000} ms`)),
              init.seamTimeoutMs ?? 30_000,
            )
          }),
        ])
      } catch (error) {
        throw new Error(
          `seam ${name} factory failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
      if (!implementation || typeof implementation !== 'object') {
        throw new Error(`seam ${name} factory returned a non-object`)
      }
      const closeable = implementation as { close?: () => void | Promise<void> }
      const disposeService = ctx.provide(service, Object.freeze(implementation))
      return async () => {
        disposeService()
        await closeable.close?.()
      }
    },
  })
}

/** Give mutable legacy seam fixtures the same ordinary-row shape as real package exports. */
export function attachTestSeamPlugins(module: PackageModule): PackageModule {
  Object.defineProperty(module, 'plugins', {
    configurable: true,
    enumerable: true,
    get() {
      return DYNAMIC_SEAM_NAMES.flatMap((name) => {
        const factory = module.seams?.[name]
        if (!factory) return []
        return [
          Object.freeze({
            declaration: Object.freeze({
              export: `${name}Plugin`,
              id: `seam:${name}`,
              runtime: 'in-process' as const,
              default: true,
            }),
            entry: normalizePluginExport(testSeamPlugin(name, factory as never)),
          }),
        ]
      })
    },
  })
  return module
}

import type { SeamImplementations, SeamName } from '@agnes/core'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { approvalPolicy } from '../extensions/approval-policy/src/seam.js'
import { artifactsLocal } from '../extensions/artifacts-local/src/seam.js'
import { budgetLedger } from '../extensions/budget/src/seam.js'
import { fsCheckpoint } from '../extensions/fs-checkpoint/src/seam.js'
import { repairPolicy, verifierT0 } from '../extensions/loop-hygiene/src/seam.js'
import { principalsLocal } from '../extensions/principals-local/src/seam.js'
import { refineHarness } from '../extensions/refine/src/seam.js'
import type { SeamFactory, SeamInitContext } from './seam-init.js'

export const HOST_SEAM_INIT = 'host:seam-init' as const

type DynamicSeamName = Exclude<SeamName, 'platform' | 'sandbox'>

/** The ordinary row config for a bundled seam is the complete resolved preset document. */
type SeamPresetConfig = Readonly<Record<string, unknown>> & {
  readonly name: string
  readonly extends?: string
}

type ConfigIssue = Readonly<{ message: string; path?: readonly PropertyKey[] }>
type ConfigResult<T> = Readonly<{ value: T }> | Readonly<{ issues: readonly ConfigIssue[] }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const seamPresetConfig = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'agnes-base',
    validate(value: unknown): ConfigResult<SeamPresetConfig> {
      if (!isPlainObject(value)) {
        return { issues: [{ message: 'expected a plain preset object' }] }
      }
      if (typeof value.name !== 'string') {
        return { issues: [{ message: 'expected a string', path: ['name'] }] }
      }
      if (value.extends !== undefined && typeof value.extends !== 'string') {
        return { issues: [{ message: 'expected a string', path: ['extends'] }] }
      }
      return { value: value as SeamPresetConfig }
    },
  }),
})

function hostValue<T>(ctx: Context, name: string): T {
  return (ctx as unknown as Record<string, T>)[name] as T
}

async function runSeamFactory<T>(name: string, factory: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      factory,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`seam ${name} timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function defineSeamPlugin<N extends DynamicSeamName>(
  name: N,
  factory: SeamFactory<SeamImplementations[N]>,
) {
  const service = `seam:${name}`
  return defineAgnesPlugin({
    name: `agnes-seam-${name}`,
    Config: seamPresetConfig,
    inject: [HOST_SEAM_INIT],
    provide: service,
    async apply(ctx: Context, config: SeamPresetConfig) {
      const init = hostValue<() => SeamInitContext>(ctx, HOST_SEAM_INIT)()
      const implementation = await runSeamFactory(
        name,
        factory({
          ...init,
          profile: Object.freeze({ ...init.profile, preset: config }),
        }),
        init.seamTimeoutMs ?? 30_000,
      )
      const closeable = implementation as SeamImplementations[N] & {
        close?: () => void | Promise<void>
      }
      let disposeService: (() => void | Promise<void>) | undefined
      try {
        disposeService = ctx.provide(service, Object.freeze(implementation))
      } catch (error) {
        await closeable.close?.()
        throw error
      }
      return async () => {
        await disposeService?.()
        await closeable.close?.()
      }
    },
  })
}

export const approvalPlugin = defineSeamPlugin('approval', approvalPolicy)
export const principalsPlugin = defineSeamPlugin('principals', principalsLocal)
export const artifactsPlugin = defineSeamPlugin('artifacts', artifactsLocal)
export const checkpointPlugin = defineSeamPlugin('checkpoint', fsCheckpoint)
export const ledgerPlugin = defineSeamPlugin('ledger', budgetLedger)
export const verifierPlugin = defineSeamPlugin('verifier', verifierT0)
export const repairPlugin = defineSeamPlugin('repair', repairPolicy)
export const harnessPlugin = defineSeamPlugin('harness', refineHarness)

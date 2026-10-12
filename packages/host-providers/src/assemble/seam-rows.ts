import { createHash } from 'node:crypto'
import type { Context } from '@agnes/cordis'
import type { ProviderSelection } from '@agnes/extension-api'
import type { SeamInit, SeamKind, SeamProvider } from '@agnes/extension-api/seams'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { modelProfileDeployment } from '@agnes/host-common/profile/model-compatibility'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { HostBuiltinRowClaim } from '@agnes/host-extensions/assemble/seams-cordis'
import {
  createPluginRow,
  EMPTY_EXTRAS_REVISION,
  type EntryRow,
  normalizePluginExport,
} from '@agnes/plugin-runtime/host'

export const REQUIRED_SEAM_ROW_IDS = Object.freeze(SEAM_KINDS.map((kind) => `seam:${kind}`))

/** The implementation a seam kind was bound to when its container was built. */
export type SeamBinding = Readonly<{
  kind: SeamKind
  provider: string
  version: string
  sourcePackage: string
  /** Builtin packages: the package integrity; third-party packages: the installed snapshot integrity. */
  integrity: string
}>

export type BuiltSeamRows = Readonly<{
  rows: readonly ReturnType<typeof createPluginRow>[]
  builtinClaims: readonly Readonly<HostBuiltinRowClaim>[]
}>

type SeamPresetConfig = Readonly<Record<string, unknown>> & { readonly name: string }

const SEAM_BINDER_SNAPSHOT = 'builtin:host-seams:v1'
const SEAM_BINDER_REVISION = 'host-seam-binder:v1'

const seamPresetConfig = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'agnes-host',
    validate(value: unknown) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { issues: [{ message: 'expected a plain preset object' }] }
      if (typeof (value as { name?: unknown }).name !== 'string')
        return { issues: [{ message: 'expected a string', path: ['name'] }] }
      return { value: value as SeamPresetConfig }
    },
  }),
})

const INSTANCE_METHODS: Readonly<Record<SeamKind, readonly string[]>> = Object.freeze({
  approval: ['ask'],
  principals: ['resolve', 'authorize'],
  billing: ['record', 'projected'],
  checkpoint: ['snapshot', 'rewind', 'list'],
  artifacts: ['put', 'get', 'submitJob', 'poll', 'cancel'],
  verifier: ['verify'],
  repair: ['decide'],
})

function failed(kind: string, reason: string, why: string): HostError {
  return new HostError('E_SEAM_INIT', `seam ${kind} ${why}`, { detail: { seam: kind, reason } })
}

/**
 * Race `create` against a timer without trusting the provider to honour the signal. An instance
 * that arrives after the timer has fired is closed at once instead of leaking.
 */
async function createWithin(
  kind: SeamKind,
  provider: SeamProvider<object>,
  init: SeamInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<object & { close?: () => void | Promise<void> }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const created = Promise.resolve().then(() => provider.create(init, signal))
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failed(kind, 'timeout', `timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    const value: unknown = await Promise.race([created, timeout])
    if (typeof value !== 'object' || value === null)
      throw failed(kind, 'shape', 'factory returned a non-object')
    const missing = INSTANCE_METHODS[kind].find(
      (method) => typeof (value as Record<string, unknown>)[method] !== 'function',
    )
    if (missing) {
      void closeQuietly(value)
      throw failed(kind, 'shape', `instance lacks ${missing}()`)
    }
    return value as object & { close?: () => void | Promise<void> }
  } catch (error) {
    void created.then(closeQuietly, () => undefined)
    if (error instanceof HostError) throw error
    throw failed(kind, 'reject', `factory failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function closeQuietly(value: unknown): Promise<void> {
  try {
    await (value as { close?: () => void | Promise<void> } | null)?.close?.()
  } catch {
    // A refused instance has nowhere to report a failed close.
  }
}

/** Everything one binding row needs; exported so the binding can be exercised without a tree. */
export type SeamBindingInput = Readonly<{
  profile: ResolvedProfile
  timeoutMs: number
  initFor(sourcePackage: string, kind: SeamKind, builtin: boolean, preset: SeamPresetConfig): SeamInit
  onBound(binding: SeamBinding): void
}>

/** The apply of one binding row: resolve the selected provider, create its instance, provide `seam:<kind>`. */
export function seamBinding(kind: SeamKind, selection: ProviderSelection, input: SeamBindingInput) {
  const id = `seam:${kind}`
  return async (ctx: Context, config: SeamPresetConfig) => {
    const providers = ctx.providers
    let provider: SeamProvider<object>
    try {
      provider = providers.resolve(kind, selection) as unknown as SeamProvider<object>
    } catch (cause) {
      throw new HostError(
        'E_SEAM_MISSING',
        `seam ${kind}: provider ${selection.provider}${selection.version ? `@${selection.version}` : ''} is not registered; install and enable its package, or change seams.${kind}.provider`,
        {
          detail: {
            seam: kind,
            provider: selection.provider,
            reason: cause instanceof Error ? cause.message : 'unknown',
          },
        },
      )
    }
    const entry = providers
      .catalog()
      .find((e) => e.kind === kind && e.id === provider.id && e.version === provider.version)
    const sourcePackage = entry?.sourcePackage ?? '@agnes/host'
    const resolved = input.profile.packages.find((pkg) => pkg.id === sourcePackage)
    const builtin = resolved ? resolved.trust === 'builtin' : sourcePackage.startsWith('@agnes/host')
    const controller = new AbortController()
    const instance = await createWithin(
      kind,
      provider,
      input.initFor(sourcePackage, kind, builtin, config),
      controller.signal,
      input.timeoutMs,
    )
    let disposeService: (() => void | Promise<void>) | undefined
    try {
      disposeService = ctx.provide(id, Object.freeze(instance))
    } catch (error) {
      await closeQuietly(instance)
      throw error
    }
    input.onBound(
      Object.freeze({
        kind,
        provider: provider.id,
        version: provider.version,
        sourcePackage,
        integrity: resolved?.integrity ?? 'host',
      }),
    )
    return async () => {
      controller.abort()
      await disposeService?.()
      await closeQuietly(instance)
    }
  }
}

/**
 * Compile the seven seam selections into Host-owned binding rows. A binding row resolves the
 * selected provider from the registry, creates its instance and provides `seam:<kind>`; it must
 * mount after every registration row, so the Host places these rows last.
 */
export function buildSeamBindingRows(
  input: Readonly<{
    profile: ResolvedProfile
    selections: Readonly<Record<SeamKind, ProviderSelection>>
    generationBuiltinRows?: readonly Readonly<EntryRow>[]
    preset: PresetDoc
    timeoutMs: number
    /** The init view for a provider of `sourcePackage`; builtin packages may receive a wider one. */
    initFor(sourcePackage: string, kind: SeamKind, builtin: boolean, preset: SeamPresetConfig): SeamInit
    onBound(binding: SeamBinding): void
  }>,
): BuiltSeamRows {
  const deployment = createHash('sha256').update(modelProfileDeployment(input.profile)).digest('hex')
  const rows: ReturnType<typeof createPluginRow>[] = []
  const claims: HostBuiltinRowClaim[] = []
  for (const kind of SEAM_KINDS) {
    const id = `seam:${kind}`
    const selection = input.selections[kind]
    const apply = seamBinding(kind, selection, input)
    const plugin = normalizePluginExport({
      Config: seamPresetConfig,
      inject: ['providers'],
      provide: id,
      apply,
    } as never)
    const pinned = input.generationBuiltinRows?.find((row) => row.id === id)
    const identity = `${SEAM_BINDER_REVISION}:${deployment}:${selection.provider}@${selection.version ?? '*'}`
    const row = createPluginRow({
      id,
      plugin: `builtin:host/seam-binder/${kind}`,
      snapshotDigest: SEAM_BINDER_SNAPSHOT,
      exportName: kind,
      entryRevision: identity,
      extrasRevision: EMPTY_EXTRAS_REVISION,
      mountRevision: identity,
      config: pinned?.config ?? input.preset,
      inject: ['providers'],
      provides: [id],
      runtime: 'in-process',
    })
    rows.push(row)
    claims.push(Object.freeze({ row, entry: plugin }))
  }
  return Object.freeze({ rows: Object.freeze(rows), builtinClaims: Object.freeze(claims) })
}

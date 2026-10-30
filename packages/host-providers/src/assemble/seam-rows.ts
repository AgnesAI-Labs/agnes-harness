import { createHash } from 'node:crypto'
import type { Context } from '@agnes/cordis'
import type { ProviderKind, ProviderSelection } from '@agnes/extension-api'
import type { SeamInit, SeamKind, SeamProvider } from '@agnes/extension-api/seams'
import { SEAM_KIND_TOKENS, SEAM_KINDS } from '@agnes/extension-api/seams'
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

/** How the instance of a refused creation was left. `pending`: its close had not settled in time. */
type Cleanup = 'clean' | 'failed' | 'pending'

function failed(kind: string, reason: string, why: string, cleanup: Cleanup = 'clean'): HostError {
  const closing =
    cleanup === 'failed'
      ? '; closing the instance also failed'
      : cleanup === 'pending'
        ? '; closing the instance did not finish'
        : ''
  return new HostError('E_SEAM_INIT', `seam ${kind} ${why}${closing}`, {
    detail: {
      seam: kind,
      reason,
      ...(cleanup === 'failed' ? { closeFailed: true } : {}),
      ...(cleanup === 'pending' ? { closePending: true } : {}),
    },
  })
}

/**
 * The most a refused creation may take, after its signal aborted, to settle and to close what it
 * produced before it is abandoned.
 */
const SEAM_CLEANUP_GRACE_MS = 1_000

type SeamInstance = object & { close?: () => void | Promise<void> }

/**
 * Race `create` against a timer. Any failure aborts the signal the provider received, then waits a
 * bounded time for the creation to settle and for its instance to close: one that never arrives, or
 * whose close never settles, is abandoned with its signal already aborted. A synchronous loop is not
 * interruptible here; that needs process isolation.
 */
async function createWithin(
  kind: SeamKind,
  provider: SeamProvider<object>,
  init: SeamInit,
  controller: AbortController,
  timeoutMs: number,
): Promise<SeamInstance> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const created = Promise.resolve().then(() => provider.create(init, controller.signal))
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })
  let refusal: Refusal
  try {
    const settled = await Promise.race([created, timeout])
    if (settled === TIMED_OUT) refusal = { reason: 'timeout', why: `timed out after ${timeoutMs} ms` }
    else {
      const missing =
        typeof settled !== 'object' || settled === null
          ? undefined
          : INSTANCE_METHODS[kind].find((m) => typeof (settled as Record<string, unknown>)[m] !== 'function')
      if (typeof settled !== 'object' || settled === null)
        refusal = { reason: 'shape', why: 'factory returned a non-object' }
      else if (missing) refusal = { reason: 'shape', why: `instance lacks ${missing}()` }
      else return settled as SeamInstance
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    refusal = controller.signal.aborted
      ? { reason: 'cancelled', why: `creation was cancelled: ${why}` }
      : { reason: 'reject', why: `factory failed: ${why}` }
    if ((error as { detail?: { reason?: unknown } } | null)?.detail?.reason === 'native-glibc-incompatible')
      refusal = { ...refusal, reason: 'native-glibc-incompatible' }
  } finally {
    clearTimeout(timer)
  }
  controller.abort()
  throw failed(kind, refusal.reason, refusal.why, await closeWithin(created, cleanupGrace(timeoutMs)))
}

const cleanupGrace = (timeoutMs: number) => Math.min(timeoutMs, SEAM_CLEANUP_GRACE_MS)

const TIMED_OUT = Symbol('seam-init-timeout')

type Refusal = { readonly reason: string; readonly why: string }

/**
 * Wait a bounded time for a refused creation to settle and for whatever it produced to close. The
 * close of an instance that arrives or finishes after the window still runs, unobserved.
 */
async function closeWithin(created: Promise<unknown>, graceMs: number): Promise<Cleanup> {
  let grace: ReturnType<typeof setTimeout> | undefined
  let closing = false
  const closed = created.then(
    (value) => {
      closing = true
      return closeQuietly(value)
    },
    () => true,
  )
  const outcome = await Promise.race([
    closed,
    new Promise<undefined>((resolve) => {
      grace = setTimeout(() => resolve(undefined), graceMs)
    }),
  ])
  clearTimeout(grace)
  if (outcome === undefined) return closing ? 'pending' : 'clean'
  return outcome ? 'clean' : 'failed'
}

/** Close an instance; false when the close threw. */
async function closeQuietly(value: unknown): Promise<boolean> {
  try {
    await (value as { close?: () => void | Promise<void> } | null)?.close?.()
    return true
  } catch {
    return false
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
      provider = providers.resolve(
        SEAM_KIND_TOKENS[kind] as unknown as ProviderKind<SeamProvider<object>>,
        selection,
      )
    } catch (cause) {
      throw new HostError(
        'E_SEAM_MISSING',
        `seam ${kind}: provider ${selection.provider}${selection.version ? `@${selection.version}` : ''} is not registered; install and enable its package, or change providers.${kind}.provider`,
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
    const builtin =
      (resolved ? resolved.trust === 'builtin' : sourcePackage.startsWith('@agnes/host')) &&
      providers.builtinRegistration(
        SEAM_KIND_TOKENS[kind] as unknown as ProviderKind<SeamProvider<object>>,
        { provider: provider.id, version: provider.version },
        sourcePackage,
      )
    const controller = new AbortController()
    const instance = await createWithin(
      kind,
      provider,
      input.initFor(sourcePackage, kind, builtin, config),
      controller,
      input.timeoutMs,
    )
    let disposeService: (() => void | Promise<void>) | undefined
    try {
      disposeService = ctx.provide(id, Object.freeze(instance))
    } catch (error) {
      controller.abort()
      await closeWithin(Promise.resolve(instance), cleanupGrace(input.timeoutMs))
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
      // A row rebuilt from a stored generation keeps the identity it had, so a cold resume is not
      // refused because today's model configuration hashes differently.
      entryRevision: pinned?.entryRevision ?? identity,
      extrasRevision: pinned?.extrasRevision ?? EMPTY_EXTRAS_REVISION,
      mountRevision: pinned?.mountRevision ?? identity,
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

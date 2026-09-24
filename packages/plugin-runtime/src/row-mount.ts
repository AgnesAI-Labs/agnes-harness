import type { Context, Fiber, Plugin } from '@agnes/cordis'
import { Inject } from '@agnes/cordis'
import {
  beginPreparedPluginPublication,
  normalizePreparedConfig,
  type PreparedPluginInvocation,
  preparePluginInvocation,
} from '@agnes/cordis/host'
import {
  buildMountIdentity,
  type EntryImporter,
  type EntryMountAdapter,
  type EntryRow,
} from '@agnes/cordis-loader'
import { createBuiltinRowMountFactory } from './internal/host-mount.js'
import { InternalMountGate } from './internal-gate.js'
import { type FiberLease, FiberLeases } from './lease.js'
import { type RowOrigin, type RowOriginLookup, RowOriginRegistry } from './row-origin.js'

export const E_ROW_IMPORT = 'E_ROW_IMPORT'
export const EMPTY_EXTRAS_REVISION = 'none'

export class VerifiedRowError extends Error {
  override readonly name = 'VerifiedRowError'

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options)
  }
}

export type VerifiedRowEntry = Readonly<{
  prepared: PreparedPluginInvocation
  inject: Readonly<Record<string, unknown>>
  provides: readonly string[]
}>

export interface PackageSnapshotCandidateRef {
  readonly packageId: string
  readonly snapshotId: string
  readonly exportName: string
  readonly generation: number
}

export interface VerifiedPackageSnapshot {
  readonly packageId: string
  readonly snapshotId: string
  readonly generation: number
  readonly digest: string
  readonly exports: readonly string[]
  readonly trusted: boolean
}

export interface PackageSnapshotVerifier {
  verify(candidate: Readonly<PackageSnapshotCandidateRef>): Promise<Readonly<VerifiedPackageSnapshot>>
}

export interface VerifiedExtrasEnvelope {
  readonly slot: string
  readonly revision: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface ExactExtrasPolicy {
  verify(
    input: Readonly<{
      row: Readonly<EntryRow>
      slot: string
      revision: string
      values: Readonly<Record<string, unknown>>
    }>,
  ): Readonly<Record<string, unknown>>
}

export interface ThirdPartyRowDescriptor {
  readonly snapshot: PackageSnapshotCandidateRef
  readonly row: Readonly<EntryRow>
  readonly entry: VerifiedRowEntry
  readonly extras?: VerifiedExtrasEnvelope
  readonly preboundLease?: FiberLease
  readonly cleanup?: () => void | Promise<void>
}

export interface ThirdPartyRowMountFactory {
  bindExtras(
    slot: string,
    revision: string,
    values: Readonly<Record<string, unknown>>,
  ): VerifiedExtrasEnvelope
  verifyAndCreate(input: ThirdPartyRowDescriptor): Promise<VerifiedRowMount>
}

export type RowImporter = EntryImporter<VerifiedRowMount | undefined>

export type HostPluginImporterFactory = (mounts: ThirdPartyRowMountFactory) => RowImporter

export interface BuiltinRowMountFactory {
  create(
    input: Readonly<{
      row: Readonly<EntryRow>
      entry: VerifiedRowEntry
      extras?: VerifiedExtrasEnvelope
    }>,
  ): Promise<VerifiedRowMount>
}

const verifiedRowMountBrand: unique symbol = Symbol('agnes.verified-row-mount')
const verifiedRowInstallationBrand: unique symbol = Symbol('agnes.verified-row-installation')

export interface VerifiedRowMount {
  readonly [verifiedRowMountBrand]: true
}

export interface VerifiedRowInstallation {
  readonly [verifiedRowInstallationBrand]: true
}

interface DescriptorSnapshot {
  readonly trustTier: 'third-party' | 'builtin'
  readonly snapshot: Readonly<PackageSnapshotCandidateRef>
  readonly digest: string
  readonly row: Readonly<EntryRow>
  readonly boundRow: Readonly<EntryRow>
  readonly entry: VerifiedRowEntry
  readonly normalizedConfig: unknown
  readonly extras?: VerifiedExtrasEnvelope
  readonly preboundLease?: FiberLease
  readonly cleanup?: () => void | Promise<void>
}

interface MountTicket {
  readonly snapshot: DescriptorSnapshot
  consumed: boolean
}

interface InstallationState {
  readonly mount: DescriptorSnapshot
  readonly wrapper: Fiber
  readonly fiber: Fiber
  rawConfig: unknown
  normalizedConfig: unknown
  readonly cleanup: readonly (() => void | Promise<void>)[]
  disposed: boolean
}

const mounts = new WeakMap<VerifiedRowMount, MountTicket>()
const installations = new WeakMap<VerifiedRowInstallation, InstallationState>()

function ownRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(input)) output[key] = input[key]
  return output
}

function cloneValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== 'object') return value
  const cached = seen.get(value)
  if (cached) return cached as T
  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value) output.push(cloneValue(item, seen))
    return output as T
  }
  const output: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(value))
  seen.set(value, output)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) output[key] = cloneValue(descriptor.value, seen)
  }
  return output as T
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (typeof value === 'function' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value as object, key)
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

function normalizeProvides(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([])
  return sortedUnique(typeof value === 'string' ? [value] : value)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const plainPrototypes: readonly unknown[] = [null, Object.prototype, Array.prototype]

// With plainOnly, only plain objects and arrays compare structurally: a Date, Map or class instance
// keeps its state outside own keys, so two different ones would otherwise look equal.
function sameValue(left: unknown, right: unknown, plainOnly = false, seen = new WeakMap()): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const prototype = Object.getPrototypeOf(left)
  if (plainOnly && (!plainPrototypes.includes(prototype) || prototype !== Object.getPrototypeOf(right)))
    return false
  if (seen.get(left) === right) return true
  seen.set(left, right)
  const leftKeys = Reflect.ownKeys(left)
  const rightKeys = Reflect.ownKeys(right)
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key) => rightKeys.includes(key))) return false
  return leftKeys.every((key) =>
    sameValue(Reflect.get(left as object, key), Reflect.get(right as object, key), plainOnly, seen),
  )
}

function sameRow(left: Readonly<EntryRow>, right: Readonly<EntryRow>): boolean {
  return (
    left.id === right.id &&
    left.plugin === right.plugin &&
    sameStrings(left.inject, right.inject) &&
    left.disabled === right.disabled &&
    sameValue(left.isolate, right.isolate) &&
    sameStrings(left.provides, right.provides) &&
    left.runtime === right.runtime &&
    left.mountIdentity === right.mountIdentity &&
    left.mountRevision === right.mountRevision &&
    left.entryRevision === right.entryRevision &&
    left.extrasRevision === right.extrasRevision &&
    sameValue(left.config, right.config)
  )
}

export function normalizePluginExport(exported: Plugin<unknown>): VerifiedRowEntry {
  const inject = deepFreeze(cloneValue(ownRecord(Inject.resolve(exported.inject))))
  const provides = normalizeProvides(exported.provide)
  const prepared = preparePluginInvocation(exported, inject)
  return Object.freeze({ prepared, inject, provides })
}

export function resolveRowImporter(...importers: readonly RowImporter[]): EntryImporter<VerifiedRowMount> {
  return async (row) => {
    const claims: VerifiedRowMount[] = []
    for (const importer of importers) {
      const claim = await importer(row)
      if (claim !== undefined) claims.push(claim)
    }
    if (claims.length !== 1) {
      throw new VerifiedRowError(
        E_ROW_IMPORT,
        claims.length ? `row ${row.id} has multiple importers` : `row ${row.id} has no importer`,
      )
    }
    return claims[0] as VerifiedRowMount
  }
}

function snapshotRow(row: Readonly<EntryRow>, normalizedConfig: unknown): Readonly<EntryRow> {
  return Object.freeze({
    id: row.id,
    plugin: row.plugin,
    inject: Object.freeze([...row.inject]),
    disabled: row.disabled,
    isolate: Object.freeze({ ...row.isolate }),
    provides: Object.freeze([...row.provides]),
    runtime: row.runtime,
    mountIdentity: row.mountIdentity,
    mountRevision: row.mountRevision,
    entryRevision: row.entryRevision,
    extrasRevision: row.extrasRevision,
    ...(row.config === undefined ? {} : { config: normalizedConfig }),
  })
}

function snapshotBoundRow(row: Readonly<EntryRow>): Readonly<EntryRow> {
  return snapshotRow(row, deepFreeze(cloneValue(row.config)))
}

function snapshotExtras(extras: VerifiedExtrasEnvelope | undefined): VerifiedExtrasEnvelope | undefined {
  if (!extras) return undefined
  return Object.freeze({
    slot: extras.slot,
    revision: extras.revision,
    values: deepFreeze(cloneValue(ownRecord(extras.values))),
  })
}

function validateEntryRow(row: Readonly<EntryRow>, entry: VerifiedRowEntry): void {
  const inject = sortedUnique(Object.keys(entry.inject))
  const provides = sortedUnique(entry.provides)
  if (!sameStrings(row.inject, inject)) {
    throw new VerifiedRowError('E_ROW_METADATA', `row ${row.id} inject metadata does not match its export`)
  }
  if (!sameStrings(row.provides, provides)) {
    throw new VerifiedRowError('E_ROW_METADATA', `row ${row.id} provide metadata does not match its export`)
  }
}

function validateExtras(
  row: Readonly<EntryRow>,
  extras: VerifiedExtrasEnvelope | undefined,
  policy: ExactExtrasPolicy | undefined,
): VerifiedExtrasEnvelope | undefined {
  if (!extras) {
    if (row.extrasRevision !== EMPTY_EXTRAS_REVISION) {
      throw new VerifiedRowError('E_EXTRAS_REVISION', `row ${row.id} requires exact extras`)
    }
    return undefined
  }
  if (row.extrasRevision !== extras.revision) {
    throw new VerifiedRowError('E_EXTRAS_REVISION', `row ${row.id} extras revision does not match`)
  }
  if (!policy) throw new VerifiedRowError('E_EXTRAS_SLOT', `row ${row.id} has no exact extras policy`)
  const values = policy.verify({
    row,
    slot: extras.slot,
    revision: extras.revision,
    values: extras.values,
  })
  return Object.freeze({
    slot: extras.slot,
    revision: extras.revision,
    values: deepFreeze(cloneValue(ownRecord(values))),
  })
}

function expectedPlugin(candidate: PackageSnapshotCandidateRef): string {
  return `${candidate.packageId}@${candidate.snapshotId}/${candidate.exportName}`
}

function assertIdentity(snapshot: DescriptorSnapshot): void {
  const expected = buildMountIdentity({
    snapshotDigest: snapshot.digest,
    exportName: snapshot.snapshot.exportName,
    entryRevision: snapshot.row.entryRevision,
    extrasRevision: snapshot.row.extrasRevision,
    plugin: snapshot.row.plugin,
    inject: snapshot.row.inject,
    isolate: snapshot.row.isolate,
    provides: snapshot.row.provides,
    runtime: snapshot.row.runtime,
    mountRevision: snapshot.row.mountRevision,
  })
  if (expected !== snapshot.row.mountIdentity) {
    throw new VerifiedRowError('E_MOUNT_IDENTITY', `row ${snapshot.row.id} has an invalid mount identity`)
  }
}

function createMount(snapshot: DescriptorSnapshot): VerifiedRowMount {
  const mount = Object.freeze({ [verifiedRowMountBrand]: true as const })
  mounts.set(mount, { snapshot, consumed: false })
  return mount
}

async function discardMount(imported: VerifiedRowMount): Promise<void> {
  const ticket = mounts.get(imported)
  if (!ticket || ticket.consumed) return
  // A prepared descriptor is not a live fiber. Marking it terminal here prevents a discarded
  // one-shot ticket from being reused while releasing any Host capability it held during verify.
  ticket.consumed = true
  const errors: unknown[] = []
  for (const dispose of [
    ...(ticket.snapshot.preboundLease ? [() => ticket.snapshot.preboundLease?.release()] : []),
    ...(ticket.snapshot.cleanup ? [ticket.snapshot.cleanup] : []),
  ]) {
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'prepared verified row cleanup failed')
}

export interface VerifiedRowHostOptions {
  /** Production Host root; supplying it installs security gates before EntryTree construction. */
  readonly root?: Context
  readonly snapshots?: PackageSnapshotVerifier
  readonly exactExtras?: ExactExtrasPolicy
  /** Explicit non-replaceable third-party namespaces in addition to the built-in host:/spine: rules. */
  readonly thirdPartyReservedRowIds?: readonly string[]
  readonly thirdPartyReservedProvides?: readonly string[]
  /** Host-private builtin assembly allowlists; these do not reserve the names against third parties. */
  readonly builtinAllowedRowIds?: readonly string[] | ReadonlySet<string>
  readonly builtinAllowedProvides?: readonly string[] | ReadonlySet<string>
  readonly leases?: FiberLeases
}

export interface VerifiedRowHost {
  readonly thirdParty: ThirdPartyRowMountFactory
  readonly builtin: BuiltinRowMountFactory
  readonly adapter: EntryMountAdapter<VerifiedRowMount, VerifiedRowInstallation>
  readonly origins: RowOriginLookup
  readonly leases: FiberLeases
}

export function createVerifiedRowHost(options: VerifiedRowHostOptions = {}): VerifiedRowHost {
  return createVerifiedRowRuntime(options, false)
}

/** Testkit-only constructor; deliberately absent from every package export map entry. */
export function createVerifiedRowTestHost(options: VerifiedRowHostOptions = {}): VerifiedRowHost {
  return createVerifiedRowRuntime(options, true)
}

function createVerifiedRowRuntime(
  options: VerifiedRowHostOptions,
  allowTestBuiltins: boolean,
): VerifiedRowHost {
  const origins = new RowOriginRegistry()
  const gate = new InternalMountGate(origins)
  if (options.root) gate.attach(options.root)
  const leases = options.leases ?? new FiberLeases()
  const thirdPartyReservedRows = new Set(options.thirdPartyReservedRowIds ?? [])
  const thirdPartyReservedProvides = new Set(options.thirdPartyReservedProvides ?? [])
  // Host keeps these sets private. Accepting its mutable sets lets a verified Host reconciliation
  // add/remove Host-authored preset claims without exposing an allowlist mutator to plugin code.
  const builtinAllowedRows =
    options.builtinAllowedRowIds instanceof Set
      ? options.builtinAllowedRowIds
      : new Set(options.builtinAllowedRowIds ?? [])
  const builtinAllowedProvides =
    options.builtinAllowedProvides instanceof Set
      ? options.builtinAllowedProvides
      : new Set(options.builtinAllowedProvides ?? [])
  const snapshotVerifier: PackageSnapshotVerifier = options.snapshots ?? {
    async verify() {
      throw new VerifiedRowError('E_SNAPSHOT_UNAVAILABLE', 'no package snapshot authority is configured')
    },
  }

  const freezeCommon = (
    trustTier: 'third-party' | 'builtin',
    input: Readonly<{
      row: Readonly<EntryRow>
      entry: VerifiedRowEntry
      extras?: VerifiedExtrasEnvelope
      preboundLease?: FiberLease
      cleanup?: () => void | Promise<void>
    }>,
    snapshot: Readonly<PackageSnapshotCandidateRef>,
    digest: string,
  ): DescriptorSnapshot => {
    if (input.row.runtime === 'isolated') {
      throw new VerifiedRowError(
        'E_RUNTIME_UNSUPPORTED',
        `row ${input.row.id} cannot use isolated runtime in this phase`,
      )
    }
    if (input.preboundLease) {
      try {
        if (
          leases.require(input.preboundLease.fiber, input.preboundLease.capability) !== input.preboundLease
        ) {
          throw new Error('lease identity changed')
        }
      } catch (cause) {
        throw new VerifiedRowError(
          'E_PREBOUND_LEASE',
          `row ${input.row.id} prebound lease is not active in this host`,
          { cause },
        )
      }
    }
    validateEntryRow(input.row, input.entry)
    const entry = Object.freeze({
      prepared: input.entry.prepared,
      inject: deepFreeze(cloneValue(ownRecord(input.entry.inject))),
      provides: Object.freeze([...input.entry.provides]),
    })
    const boundRow = snapshotBoundRow(input.row)
    const normalizedConfig = deepFreeze(normalizePreparedConfig(entry.prepared, cloneValue(boundRow.config)))
    const preliminaryRow = snapshotRow(boundRow, normalizedConfig)
    const extras = snapshotExtras(input.extras)
    const checkedExtras = validateExtras(preliminaryRow, extras, options.exactExtras)
    return Object.freeze({
      trustTier,
      snapshot,
      digest,
      row: preliminaryRow,
      boundRow,
      entry,
      normalizedConfig,
      ...(checkedExtras ? { extras: checkedExtras } : {}),
      ...(input.preboundLease ? { preboundLease: input.preboundLease } : {}),
      ...(input.cleanup ? { cleanup: input.cleanup } : {}),
    })
  }

  const thirdParty: ThirdPartyRowMountFactory = {
    bindExtras(slot: string, revision: string, values: Readonly<Record<string, unknown>>) {
      return Object.freeze({
        slot,
        revision,
        values: deepFreeze(cloneValue(ownRecord(values))),
      })
    },
    async verifyAndCreate(input: ThirdPartyRowDescriptor) {
      const candidate = Object.freeze({
        packageId: input.snapshot.packageId,
        snapshotId: input.snapshot.snapshotId,
        exportName: input.snapshot.exportName,
        generation: input.snapshot.generation,
      })
      if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 1) {
        throw new VerifiedRowError(
          'E_SNAPSHOT_CHANGED',
          'candidate generation must be a positive safe integer',
        )
      }
      const frozen = freezeCommon(
        'third-party',
        {
          row: input.row,
          entry: input.entry,
          ...(input.extras ? { extras: input.extras } : {}),
          ...(input.preboundLease ? { preboundLease: input.preboundLease } : {}),
          ...(input.cleanup ? { cleanup: input.cleanup } : {}),
        },
        candidate,
        '',
      )
      if (
        thirdPartyReservedRows.has(frozen.row.id) ||
        frozen.row.id.startsWith('host:') ||
        frozen.row.id.startsWith('spine:')
      ) {
        throw new VerifiedRowError('E_RESERVED_ROW', `third-party row cannot claim ${frozen.row.id}`)
      }
      const reserved = frozen.row.provides.find(
        (name) =>
          thirdPartyReservedProvides.has(name) || name.startsWith('host:') || name.startsWith('spine:'),
      )
      if (reserved)
        throw new VerifiedRowError('E_RESERVED_PROVIDE', `third-party row cannot provide ${reserved}`)
      if (frozen.row.plugin !== expectedPlugin(candidate)) {
        throw new VerifiedRowError('E_PLUGIN_SPEC', `row ${frozen.row.id} does not match its snapshot`)
      }

      const verifiedInput = await snapshotVerifier.verify(candidate)
      const verified = Object.freeze({
        packageId: verifiedInput.packageId,
        snapshotId: verifiedInput.snapshotId,
        generation: verifiedInput.generation,
        digest: verifiedInput.digest,
        exports: Object.freeze([...verifiedInput.exports]),
        trusted: verifiedInput.trusted,
      })
      if (!verified.trusted)
        throw new VerifiedRowError('E_SNAPSHOT_UNTRUSTED', `${candidate.packageId} is not trusted`)
      if (
        verified.packageId !== candidate.packageId ||
        verified.snapshotId !== candidate.snapshotId ||
        verified.generation !== candidate.generation
      ) {
        throw new VerifiedRowError(
          'E_SNAPSHOT_CHANGED',
          `${candidate.packageId} snapshot changed during verification`,
        )
      }
      if (!verified.exports.includes(candidate.exportName)) {
        throw new VerifiedRowError(
          'E_SNAPSHOT_EXPORT',
          `${candidate.exportName} is not in the installed snapshot`,
        )
      }
      const complete = Object.freeze({ ...frozen, digest: verified.digest })
      assertIdentity(complete)
      return createMount(complete)
    },
  }
  Object.freeze(thirdParty)

  const builtin = createBuiltinRowMountFactory({
    allowedRowIds: builtinAllowedRows,
    allowedProvides: builtinAllowedProvides,
    allowTestRows: allowTestBuiltins,
    create(input) {
      const snapshot = Object.freeze({
        packageId: 'builtin',
        snapshotId: 'builtin',
        exportName: input.row.plugin,
        generation: 1,
      })
      const frozen = freezeCommon('builtin', input, snapshot, '')
      // D74 deliberately trusts the single desired-row builder identity for builtins.
      return createMount(frozen)
    },
  })

  const adapter = createVerifiedRowAdapter(gate, leases)
  return Object.freeze({ thirdParty, builtin, adapter, origins, leases })
}

const wrapperPrepared = preparePluginInvocation(() => {}, Object.freeze(Object.create(null)))

function originOf(mount: DescriptorSnapshot): Readonly<RowOrigin> {
  return Object.freeze({
    trustTier: mount.trustTier,
    packageId: mount.snapshot.packageId,
    snapshotId: mount.snapshot.snapshotId,
    rowId: mount.row.id,
    exportName: mount.snapshot.exportName,
    declaredProvides: Object.freeze([...mount.row.provides]),
  })
}

function createVerifiedRowAdapter(
  gate: InternalMountGate,
  leases: FiberLeases,
): EntryMountAdapter<VerifiedRowMount, VerifiedRowInstallation> {
  const adapter: EntryMountAdapter<VerifiedRowMount, VerifiedRowInstallation> = {
    async mount(parent, row, imported) {
      const ticket = mounts.get(imported)
      if (!ticket || ticket.consumed) {
        throw new VerifiedRowError('E_VERIFIED_MOUNT', `row ${row.id} was not verified for this mount`)
      }
      // Consume before validation or any await: every attempted use is terminal, including failures.
      ticket.consumed = true
      const mount = ticket.snapshot
      if (!sameRow(mount.boundRow, row)) {
        const error = new VerifiedRowError(
          'E_VERIFIED_MOUNT',
          `row ${row.id} differs from its verified snapshot`,
        )
        const cleanupErrors: unknown[] = []
        for (const dispose of [
          ...(mount.preboundLease ? [() => mount.preboundLease?.release()] : []),
          ...(mount.cleanup ? [mount.cleanup] : []),
        ]) {
          try {
            await dispose()
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
        if (cleanupErrors.length)
          throw new AggregateError([error, ...cleanupErrors], 'verified row mount rejected')
        throw error
      }
      const cleanup: (() => void | Promise<void>)[] = []
      cleanup.push(gate.attach(parent.root))
      const batch = beginPreparedPluginPublication()
      let wrapper!: Fiber
      let fiber!: Fiber
      try {
        let wrapperParent = parent
        for (const name of Object.keys(mount.extras?.values ?? {}).sort()) {
          wrapperParent = wrapperParent.isolate(name)
        }
        wrapper = batch.plugin(wrapperParent, wrapperPrepared, undefined, (candidate) => {
          cleanup.push(
            gate.bindWrapper(candidate, mount.extras?.values ?? Object.freeze(Object.create(null))),
          )
        })
        for (const [name, value] of Object.entries(mount.extras?.values ?? {})) {
          wrapper.ctx.provide(name, value)
        }
        fiber = batch.plugin(wrapper.ctx, mount.entry.prepared, mount.normalizedConfig, (candidate) => {
          cleanup.push(gate.bindRow(candidate, originOf(mount)))
          if (mount.preboundLease) {
            // The candidate receives a fresh exact-child lease. The source lease remains owned by
            // the descriptor until this installation (or failed attempt) is cleaned up.
            leases.bind(candidate, mount.preboundLease.capability)
          }
        })
        const published = batch.publish()
        await Promise.all(published)
        // Publication makes the fibers visible atomically; readiness still requires the actual
        // plugin callback to settle. Surface startup failures here instead of letting Host's later
        // required-service audit replace the author's error with a generic missing-row message.
        await fiber.await()
      } catch (error) {
        const disposers: (() => void | Promise<void>)[] = [() => batch.rollback()]
        disposers.push(...cleanup.reverse())
        if (mount.preboundLease) disposers.push(() => mount.preboundLease?.release())
        if (mount.cleanup) disposers.push(mount.cleanup)
        const cleanupErrors: unknown[] = []
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
        if (cleanupErrors.length)
          throw new AggregateError([error, ...cleanupErrors], 'verified row mount failed')
        throw error
      }

      const installation = Object.freeze({ [verifiedRowInstallationBrand]: true as const })
      installations.set(installation, {
        mount,
        wrapper,
        fiber,
        rawConfig: row.config,
        normalizedConfig: mount.normalizedConfig,
        cleanup,
        disposed: false,
      })
      return installation
    },

    discard: discardMount,

    async update(current, row) {
      const state = installations.get(current)
      if (!state || state.disposed) {
        return { status: 'removed', cause: new Error('installation is not active'), fatal: true }
      }
      let normalized: unknown
      try {
        normalized = deepFreeze(normalizePreparedConfig(state.mount.entry.prepared, cloneValue(row.config)))
        // A re-decoded row carries a fresh config object even when nothing changed. Restarting
        // on that would reload the plugin for nothing on every reconciliation of this tree.
        if (sameValue(state.normalizedConfig, normalized, true)) {
          state.rawConfig = row.config
          return { status: 'updated' }
        }
        await state.fiber.update(normalized)
        await state.fiber.await()
        state.rawConfig = row.config
        state.normalizedConfig = normalized
        return { status: 'updated' }
      } catch (cause) {
        try {
          await state.fiber.update(state.normalizedConfig, true)
          await state.fiber.await()
          return { status: 'restored', cause }
        } catch (restoreCause) {
          await disposeInstallation(state)
          return {
            status: 'removed',
            cause: new AggregateError([cause, restoreCause], 'config update and restore failed'),
            fatal: true,
          }
        }
      }
    },

    async unmount(current) {
      const state = installations.get(current)
      if (!state) return
      await disposeInstallation(state)
    },

    fiber(current) {
      const state = installations.get(current)
      if (!state) throw new Error('unknown verified row installation')
      return state.fiber
    },
  }
  return Object.freeze(adapter)
}

async function disposeInstallation(state: InstallationState): Promise<void> {
  if (state.disposed) return
  state.disposed = true
  const disposers: (() => void | Promise<void>)[] = [() => state.wrapper.dispose()]
  disposers.push(...[...state.cleanup].reverse())
  if (state.mount.preboundLease) disposers.push(() => state.mount.preboundLease?.release())
  if (state.mount.cleanup) disposers.push(state.mount.cleanup)
  const errors: unknown[] = []
  for (const dispose of disposers) {
    try {
      await dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'verified row cleanup failed')
}

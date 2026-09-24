import { Context } from '@agnes/cordis'
import {
  createEntryTreeHostTransaction,
  createVerifiedRowHost,
  type EntryRow,
  EntryTree,
  type EntryTreeTransactionJournal,
  type EntryTreeTransactionPrepareOptions,
  type ExactExtrasPolicy,
  type FiberLeases,
  type HostPluginImporterFactory,
  type PackageSnapshotVerifier,
  type PreparedEntryTreeTransaction,
  type RowImporter,
  type RowOriginLookup,
  resolveRowImporter,
  type ThirdPartyRowMountFactory,
  type VerifiedExtrasEnvelope,
  type VerifiedRowEntry,
  type VerifiedRowInstallation,
  type VerifiedRowMount,
} from '@agnes/plugin-runtime/host'
import { bindSkillRuntimeRows, type SkillCordisService } from '@agnes/resource-control-runtime'
import { HostError } from '../errors.js'

export interface HostPluginTreeBase {
  readonly root: Context
  readonly tree: EntryTree<VerifiedRowMount, VerifiedRowInstallation>
  readonly leases: FiberLeases
  readonly bootRows: readonly Readonly<EntryRow>[]
  currentRows(): readonly Readonly<EntryRow>[]
  applyRows(rows: readonly Readonly<EntryRow>[]): Promise<void>
  /** Host-only prepared row transaction; callers must not use public applyRows for atomic work. */
  readonly prepareRows?: (
    rows: readonly Readonly<EntryRow>[],
    options?: HostPrepareRowsOptions,
  ) => Promise<PreparedEntryTreeTransaction<VerifiedRowMount>>
  readonly applyPreparedRows?: (
    prepared: PreparedEntryTreeTransaction<VerifiedRowMount>,
  ) => Promise<EntryTreeTransactionJournal>
  readonly compensateRows?: (journal: EntryTreeTransactionJournal) => Promise<void>
  /** After a successful delivery: keep only the newest importer and that delivery's builtin claims. */
  readonly commitPeriod?: () => void
  /** After a failed delivery, once compensation is done: forget what the last prepareRows added. */
  readonly rollbackPeriod?: () => void
  /** True once a transaction abandoned an adapter call whose fiber may never settle. */
  readonly tainted?: () => boolean
}

/** Host-only transaction options; the candidate importer is combined with Host builtin authority. */
export type HostPrepareRowsOptions = Omit<
  EntryTreeTransactionPrepareOptions<VerifiedRowMount>,
  'importer'
> & {
  readonly candidateImporter?: HostPluginImporterFactory
  /** This delivery's builtin claims; they are added next to the ones the tree already knows. */
  readonly builtinClaims?: readonly Readonly<HostBuiltinRowClaim>[]
}

export interface AssembleOrdinaryPluginTreeOptions {
  /**
   * An optional package-backed importer. It receives only the restricted third-party mount factory;
   * Host keeps the builtin factory and every verification authority inside this assembly boundary.
   */
  pluginImporter?: HostPluginImporterFactory
  /** Host-owned installed-snapshot authority; the package importer never receives this object. */
  snapshots?: PackageSnapshotVerifier
  /** How long the tree may take to start before the assembly is abandoned. Defaults to 30 seconds. */
  startTimeoutMs?: number
}

export const DEFAULT_TREE_START_TIMEOUT_MS = 30_000

/**
 * Rejects with a start-timeout error when `work` has not settled in `ms`. The work is abandoned,
 * not cancelled: nothing can cancel a plugin callback that never returns.
 */
function withStartDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new HostError('E_EXT_LOAD', `the plugin tree did not finish starting within ${ms} ms`, {
          detail: { reason: 'row-start-timeout', timeoutMs: ms },
        }),
      )
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isStartTimeout(error: unknown): boolean {
  return (
    error instanceof HostError &&
    (error.detail as { reason?: unknown } | undefined)?.reason === 'row-start-timeout'
  )
}

/** Host-assembly-only input. This type is deliberately absent from the package root. */
export interface HostBuiltinRowClaim {
  readonly row: Readonly<EntryRow>
  readonly entry: VerifiedRowEntry
  readonly extras?: VerifiedExtrasEnvelope
}

/**
 * Inputs produced by Host's trusted desired-row builder.
 *
 * This is a second, internal argument so neither HostOptions nor a package importer can obtain the
 * builtin factory or the exact-extras policy.
 */
export interface HostPrivatePluginTreeInput {
  readonly bootRows?: readonly Readonly<EntryRow>[]
  /** Includes default:false builtins that are registered now but intentionally absent from bootRows. */
  readonly builtinClaims?: readonly Readonly<HostBuiltinRowClaim>[]
  readonly exactExtras?: ExactExtrasPolicy
  /** Host-owned injection envelopes automatically attached to matching third-party rows. */
  readonly thirdPartyExtras?: Readonly<Record<string, VerifiedExtrasEnvelope>>
  readonly thirdPartyReservedRowIds?: readonly string[]
  readonly thirdPartyReservedProvides?: readonly string[]
  /** Required row/service ids that must remain exactly owned by their installed row fiber. */
  readonly requiredRowIds?: readonly string[]
  readonly afterApply?: () => void | Promise<void>
  /**
   * Provides Host-owned services on each tree root before any row mounts. It is a per-root factory:
   * a candidate tree is built next to the live one, and each root needs services that resolve row
   * origins against its own registry.
   */
  readonly rootServices?: (root: Context, origins: RowOriginLookup) => void
  /**
   * Contribution service for plugins that register skills during apply. The worker passes the
   * service bound to the registry whose snapshot the skills extension already reads.
   */
  readonly skillContribution?: SkillCordisService
}

export interface AssembledOrdinaryPluginTree {
  readonly pluginTree: HostPluginTreeBase
  /** Host-assembly-private claim refresh for Host-authored rows such as dynamic preset data. */
  replaceBuiltinClaims(claims: readonly Readonly<HostBuiltinRowClaim>[]): void
  close(): Promise<void>
}

/**
 * Build the ordinary Cordis tree. With no private input it remains a deny-by-default empty tree;
 * Host assembly supplies preset and seam rows plus the installed-snapshot authority.
 */
export async function assembleOrdinaryPluginTree(
  options: AssembleOrdinaryPluginTreeOptions = {},
  privateInput: HostPrivatePluginTreeInput = {},
): Promise<AssembledOrdinaryPluginTree> {
  const prepared = preparePrivateInput(privateInput)
  const root = new Context()
  // Claims are keyed by row id and identity so a later delivery can add a new identity for a row
  // while compensation can still re-import the old one. The two allow-lists are the live sets the
  // verified row host checks on every builtin mount.
  const builtinByKey = new Map<string, Readonly<HostBuiltinRowClaim>>()
  const builtinAllowedRowIds = new Set<string>()
  const builtinAllowedProvides = new Set<string>()
  const addClaims = (claims: Iterable<Readonly<HostBuiltinRowClaim>>) => {
    for (const claim of claims) {
      builtinByKey.set(claimKey(claim.row), claim)
      builtinAllowedRowIds.add(claim.row.id)
      for (const provided of claim.row.provides) builtinAllowedProvides.add(provided)
    }
  }
  const resetClaims = (claims: Iterable<Readonly<HostBuiltinRowClaim>>) => {
    builtinByKey.clear()
    builtinAllowedRowIds.clear()
    builtinAllowedProvides.clear()
    addClaims(claims)
  }
  addClaims(prepared.builtinById.values())
  let committedClaims = [...builtinByKey.values()]
  let lastClaims: Readonly<HostBuiltinRowClaim>[] | undefined
  const runtime = createVerifiedRowHost({
    root,
    builtinAllowedRowIds,
    builtinAllowedProvides,
    ...(privateInput.thirdPartyReservedRowIds
      ? { thirdPartyReservedRowIds: privateInput.thirdPartyReservedRowIds }
      : {}),
    thirdPartyReservedProvides: Object.freeze([
      ...new Set([
        'seam:platform',
        'seam:sandbox',
        'extension',
        ...(privateInput.thirdPartyReservedProvides ?? []),
      ]),
    ]),
    ...(privateInput.exactExtras ? { exactExtras: privateInput.exactExtras } : {}),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
  })
  let closing: Promise<void> | undefined
  try {
    if (privateInput.skillContribution) {
      root.provide('skills', privateInput.skillContribution)
      bindSkillRuntimeRows(root, runtime.origins)
    }
    privateInput.rootServices?.(root, runtime.origins)
    const builtinImporter: RowImporter = async (row) => {
      const claim = builtinByKey.get(claimKey(row))
      if (!claim) return undefined
      return runtime.builtin.create({
        row,
        entry: claim.entry,
        ...(claim.extras ? { extras: claim.extras } : {}),
      })
    }
    // Each delivery's package importer only recognises its own delivery's rows. The newest is asked
    // first, so an unchanged row resolves to the latest delivery while compensation can still reach
    // an older identity through the delivery that introduced it.
    const bindImporter = (factory: HostPluginImporterFactory) =>
      factory(bindHostExtras(runtime.thirdParty, prepared.thirdPartyExtras))
    let periods: RowImporter[] = options.pluginImporter ? [bindImporter(options.pluginImporter)] : []
    let committedPeriods = periods
    const thirdPartyImporter: RowImporter = async (row) => {
      for (const importer of periods) {
        const claim = await importer(row)
        if (claim !== undefined) return claim
      }
      return undefined
    }
    const tree = new EntryTree(root, resolveRowImporter(builtinImporter, thirdPartyImporter), runtime.adapter)
    const transaction = createEntryTreeHostTransaction(tree)
    const bootRows = prepared.bootRows
    await withStartDeadline(tree.apply(bootRows), options.startTimeoutMs ?? DEFAULT_TREE_START_TIMEOUT_MS)
    auditRequiredRows(root, tree, runtime.origins, prepared.requiredRowIds)
    const pluginTree: HostPluginTreeBase = Object.freeze({
      root,
      tree,
      leases: runtime.leases,
      bootRows,
      currentRows: () => Object.freeze(tree.currentRows().map(snapshotBuilderRow)),
      async applyRows(rows: readonly Readonly<EntryRow>[]) {
        assertBuilderRows(rows)
        const desired = Object.freeze(rows.map(snapshotBuilderRow))
        let applyError: unknown
        try {
          await tree.apply(desired)
        } catch (error) {
          applyError = error
        }
        let afterApplyError: unknown
        try {
          await prepared.afterApply?.()
        } catch (error) {
          afterApplyError = error
        }
        if (applyError !== undefined && afterApplyError !== undefined) {
          throw new AggregateError(
            [applyError, afterApplyError],
            'ordinary plugin reconciliation and invalidation failed',
          )
        }
        if (applyError !== undefined) throw applyError
        if (afterApplyError !== undefined) throw afterApplyError
        auditRequiredRows(root, tree, runtime.origins, prepared.requiredRowIds)
      },
      prepareRows(rows: readonly Readonly<EntryRow>[], options?: HostPrepareRowsOptions) {
        assertBuilderRows(rows)
        const { candidateImporter, builtinClaims, ...transactionOptions } = options ?? {}
        if (candidateImporter) periods = [bindImporter(candidateImporter), ...periods]
        if (builtinClaims) {
          lastClaims = [...snapshotBuiltinClaimMap(builtinClaims).values()]
          addClaims(lastClaims)
        }
        return transaction.prepare(rows, transactionOptions)
      },
      applyPreparedRows(prepared: PreparedEntryTreeTransaction<VerifiedRowMount>) {
        return transaction.apply(prepared)
      },
      compensateRows(journal: EntryTreeTransactionJournal) {
        return transaction.compensate(journal)
      },
      commitPeriod() {
        periods = periods.slice(0, 1)
        committedPeriods = periods
        if (lastClaims) committedClaims = lastClaims
        lastClaims = undefined
        resetClaims(committedClaims)
      },
      rollbackPeriod() {
        periods = committedPeriods
        lastClaims = undefined
        resetClaims(committedClaims)
      },
      tainted: () => tree.tainted,
    })
    return {
      pluginTree,
      replaceBuiltinClaims(claims) {
        committedClaims = [...snapshotBuiltinClaimMap(claims).values()]
        resetClaims(committedClaims)
      },
      close() {
        if (!closing) {
          if (tree.tainted) {
            // A fiber on this tree never settled. Waiting for it would hold the mutation gate for
            // ever, so this tree winds down in the background, the way a stuck candidate does.
            void closeOrdinaryPluginTree(root, tree).catch(() => undefined)
            closing = Promise.resolve()
          } else {
            closing = closeOrdinaryPluginTree(root, tree)
          }
        }
        return closing
      },
    }
  } catch (error) {
    if (isStartTimeout(error)) {
      // The stuck plugin's fiber never settles, so disposing the root would wait on it for ever and
      // hold the whole apply queue with it. This root belongs to a candidate nobody can see, so it
      // is left to wind down in the background and the assembly fails right away.
      void root.fiber.dispose().catch(() => undefined)
      throw error
    }
    try {
      await root.fiber.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'ordinary plugin tree assembly and cleanup failed')
    }
    throw error
  }
}

function claimKey(row: Readonly<EntryRow>): string {
  return `${row.id}\0${row.mountIdentity}`
}

type PreparedPrivateInput = Readonly<{
  bootRows: readonly Readonly<EntryRow>[]
  builtinClaims: readonly Readonly<HostBuiltinRowClaim>[]
  builtinById: ReadonlyMap<string, Readonly<HostBuiltinRowClaim>>
  requiredRowIds: readonly string[]
  thirdPartyExtras: Readonly<Record<string, VerifiedExtrasEnvelope>>
  afterApply?: () => void | Promise<void>
}>

function preparePrivateInput(input: HostPrivatePluginTreeInput): PreparedPrivateInput {
  const sourceRows = input.bootRows ?? []
  const sourceClaims = input.builtinClaims ?? []
  assertBuilderRows(sourceRows)

  const bootById = new Map(sourceRows.map((row) => [row.id, row]))
  const builtinById = snapshotBuiltinClaimMap(sourceClaims)
  for (const claim of builtinById.values()) {
    const bootRow = bootById.get(claim.row.id)
    if (bootRow && !sameCompleteRow(claim.row, bootRow)) {
      throw new TypeError(`builtin claim ${claim.row.id} does not match its complete boot row`)
    }
  }

  return Object.freeze({
    bootRows: Object.freeze(sourceRows.map(snapshotBuilderRow)),
    builtinClaims: Object.freeze([...builtinById.values()]),
    builtinById,
    requiredRowIds: Object.freeze([...new Set(input.requiredRowIds ?? [])].sort()),
    thirdPartyExtras: snapshotThirdPartyExtras(input.thirdPartyExtras),
    ...(input.afterApply ? { afterApply: input.afterApply } : {}),
  })
}

function snapshotBuiltinClaimMap(
  claims: readonly Readonly<HostBuiltinRowClaim>[],
): Map<string, Readonly<HostBuiltinRowClaim>> {
  const output = new Map<string, Readonly<HostBuiltinRowClaim>>()
  for (const claim of claims) {
    if (output.has(claim.row.id)) throw new TypeError(`duplicate builtin claim for row ${claim.row.id}`)
    assertBuilderRows([claim.row])
    output.set(claim.row.id, snapshotBuiltinClaim(claim))
  }
  return output
}

function snapshotThirdPartyExtras(
  source: Readonly<Record<string, VerifiedExtrasEnvelope>> | undefined,
): Readonly<Record<string, VerifiedExtrasEnvelope>> {
  const output: Record<string, VerifiedExtrasEnvelope> = Object.create(null)
  for (const [rowId, extras] of Object.entries(source ?? {})) {
    output[rowId] = Object.freeze({
      slot: extras.slot,
      revision: extras.revision,
      values: Object.freeze({ ...extras.values }),
    })
  }
  return Object.freeze(output)
}

function bindHostExtras(
  mounts: ThirdPartyRowMountFactory,
  extrasByRow: Readonly<Record<string, VerifiedExtrasEnvelope>>,
): ThirdPartyRowMountFactory {
  return Object.freeze({
    bindExtras: mounts.bindExtras.bind(mounts),
    verifyAndCreate(input: Parameters<ThirdPartyRowMountFactory['verifyAndCreate']>[0]) {
      const extras = extrasByRow[input.row.id]
      if (!extras) return mounts.verifyAndCreate(input)
      return mounts.verifyAndCreate({
        ...input,
        extras: mounts.bindExtras(extras.slot, extras.revision, extras.values),
      })
    },
  })
}

function auditRequiredRows(
  root: Context,
  tree: EntryTree<VerifiedRowMount, VerifiedRowInstallation>,
  origins: {
    lookup(fiber: import('@agnes/cordis').Fiber): import('@agnes/plugin-runtime/host').RowOrigin | undefined
  },
  requiredRowIds: readonly string[],
): void {
  const rows = new Map(tree.currentRows().map((row) => [row.id, row]))
  for (const id of requiredRowIds) {
    const row = rows.get(id)
    const fiber = tree.fiber(id)
    const impl = root.reflect._getImpl(id, true)
    const origin = fiber ? origins.lookup(fiber) : undefined
    const reasons = [
      !row && 'row',
      row?.disabled && 'disabled',
      row && (row.provides.length !== 1 || row.provides[0] !== id) && 'row-provides',
      !fiber && 'fiber',
      !impl && 'implementation',
      impl && fiber && impl.fiber !== fiber && 'implementation-owner',
      !origin && 'origin',
      origin && origin.rowId !== id && 'origin-row',
      origin &&
        (origin.declaredProvides.length !== 1 || origin.declaredProvides[0] !== id) &&
        'origin-provides',
    ].filter(Boolean)
    if (reasons.length) {
      throw new Error(`E_SEAM_MISSING: required row ${id} has no exact live owner (${reasons.join(',')})`)
    }
  }
}

function snapshotBuiltinClaim(claim: Readonly<HostBuiltinRowClaim>): Readonly<HostBuiltinRowClaim> {
  return Object.freeze({
    row: snapshotBuilderRow(claim.row),
    entry: claim.entry,
    ...(claim.extras
      ? {
          extras: Object.freeze({
            slot: claim.extras.slot,
            revision: claim.extras.revision,
            values: Object.freeze({ ...claim.extras.values }),
          }),
        }
      : {}),
  })
}

function assertBuilderRows(rows: readonly Readonly<EntryRow>[]): void {
  for (const row of rows) {
    const staticComponent =
      row && typeof row === 'object'
        ? [row.id, ...(Array.isArray(row.provides) ? row.provides : [])].find(
            (value) => value === 'seam:platform' || value === 'seam:sandbox',
          )
        : undefined
    if (staticComponent) {
      throw Object.assign(
        new Error(`static component cannot be applied as a plugin row: ${staticComponent}`),
        {
          code: 'E_STATIC_COMPONENT' as const,
        },
      )
    }
    if (!row || typeof row !== 'object' || !Object.isFrozen(row)) {
      throw new TypeError('ordinary tree accepts only immutable rows from the trusted row builder')
    }
    if (
      !Object.hasOwn(row, 'mountIdentity') ||
      typeof row.mountIdentity !== 'string' ||
      row.mountIdentity.length === 0
    ) {
      throw new TypeError(`trusted row ${String(row.id)} must carry its own mountIdentity`)
    }
  }
}

function snapshotBuilderRow(row: Readonly<EntryRow>): Readonly<EntryRow> {
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
    ...(row.config === undefined ? {} : { config: immutableConfig(row.config) }),
  })
}

function immutableConfig(value: unknown): unknown {
  return deeplyFrozen(value) ? value : snapshotConfig(value)
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true
  if (seen.has(value)) return true
  if (!Object.isFrozen(value)) return false
  seen.add(value)
  const frozen = Object.values(value).every((child) => deeplyFrozen(child, seen))
  seen.delete(value)
  return frozen
}

function snapshotConfig(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotConfig))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = snapshotConfig((value as Record<string, unknown>)[key])
    }
    return Object.freeze(output)
  }
  return value
}

function sameCompleteRow(left: Readonly<EntryRow>, right: Readonly<EntryRow>): boolean {
  return (
    left.id === right.id &&
    left.plugin === right.plugin &&
    sameStrings(left.inject, right.inject) &&
    left.disabled === right.disabled &&
    sameRecord(left.isolate, right.isolate) &&
    sameStrings(left.provides, right.provides) &&
    left.runtime === right.runtime &&
    left.mountIdentity === right.mountIdentity &&
    left.mountRevision === right.mountRevision &&
    left.entryRevision === right.entryRevision &&
    left.extrasRevision === right.extrasRevision &&
    JSON.stringify(snapshotConfig(left.config)) === JSON.stringify(snapshotConfig(right.config))
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

async function closeOrdinaryPluginTree(
  root: Context,
  tree: EntryTree<VerifiedRowMount, VerifiedRowInstallation>,
): Promise<void> {
  const failures: unknown[] = []
  // EntryTree removes a failing installation from its map in `finally`, but stops that apply pass.
  // Repeat until empty so every row reaches the adapter's all-settled descriptor cleanup path.
  while (tree.currentRows().length) {
    try {
      await tree.apply([])
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await root.fiber.dispose()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, 'ordinary plugin tree cleanup failed')
}

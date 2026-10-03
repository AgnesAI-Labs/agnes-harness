import type { AuthorityTransferControl, CallContext } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeAuthorityTransferAPI,
  RuntimeErrorDetails,
  type RuntimeWireTypes,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'
import type { CaseContext, ConformanceHarness } from '../harness.js'
import {
  type ConformanceBinding,
  callContext,
  type Judge,
  outcomeOf,
  registerScenarios,
  same,
} from './blob.js'
import { inline } from './projection.js'

const FEATURE = RuntimeAuthorityTransferAPI.feature
/** The descriptor operations the feature adds, by their backend method names. */
const OPERATIONS: readonly string[] = Object.values(RuntimeAuthorityTransferAPI.methods).map(
  (method) => method.backendMethod,
)
const HEX = /^[a-f0-9]{64}$/

/** The authorization ref the suite's maintenance controller calls with; any other is an outsider's. */
export const TRANSFER_MAINTAINER = 'transfer-maintainer'

const UPGRADE = 'conformance-upgrade'
const COHORT = canonicalJsonDigest('conformance-cohort')
const OTHER_COHORT = canonicalJsonDigest('conformance-other-cohort')
const CUTOVER = 'conformance-cutover'
const RECOVERY = 'conformance-recovery'
const TARGET = 'conformance-target'
const PAGE_LIMIT = 2
/** An interrupted import may read the root page and one chunk; the next read fails. */
const INTERRUPT_AFTER = 2
const NONE = 'conformance-none'
const schema = (typeId: string): Wire.SchemaRef => ({
  typeId,
  revision: 1,
  digest: canonicalJsonDigest(typeId),
})
const routeRef = (route: Wire.AuthorityRoute) =>
  inline(schema('agh.conformance/authority-route@1'), route as unknown as Wire.JsonValue)

/** One store as the transfer suite drives it. A reopen replaces the instance, so `control()` is read again. */
export interface TransferStore {
  control(): AuthorityTransferControl
  /** One ordinary business write: `null` when the store accepted it, else the refusal's detail code. */
  write(): Promise<string | null>
  /** Whether the store reads back what its world seeded: live content intact, deleted content still gone. */
  serves(): Promise<boolean>
  reopen(): Promise<void>
  close(): Promise<void>
}

/**
 * A fresh source seeded with enough content for at least three export parts, including deleted
 * content; the maintenance directory its stores read routes from; and the locations a target opens at.
 * Targets come from the same implementation as the source, because collection schemas are not shared
 * across implementations.
 */
export interface TransferWorld {
  readonly descriptor: Wire.ProviderDescriptor
  readonly source: TransferStore
  /** The source authority as it serves now, at `locationRef`. */
  readonly authority: Wire.StateAuthorityRef
  readonly locationRef: Wire.Id
  readonly providerBinding: Wire.BindingRef
  /** The store at another directory location, opened empty as an import target; the same location again is the same store. */
  target(locationRef: Wire.Id): Promise<TransferStore>
  /** Durably records `route` as the directory's route for its authority, and whether a target was activated. */
  publish(route: Wire.AuthorityRoute, targetActivated: boolean): void
  /** Lets `after` more reads of the source's exported bytes through and fails every later one; `null` heals it. */
  cut(after: number | null): void
  /** Rewrites the stored bytes of one exported chunk behind the source's back. */
  tamper(chunk: Wire.BlobRef): Promise<void>
  /** Changes the candidate's stored records at `locationRef` behind its store's back. */
  damage(locationRef: Wire.Id): Promise<void>
  /** Closes every store and releases the world's storage. */
  dispose(): Promise<void>
}

/** A provider that declares authority transfer as the suite drives it. */
export interface TransferSubject {
  /** Opens a fresh world; without `maintained` the stores have no maintenance fixture. */
  open(maintained: boolean): Promise<TransferWorld>
}

type Fact<T> = { readonly value: T } | { readonly refused: string }
type Fence = Wire.AuthorityFence
type Export = Wire.AuthorityExport
type Probe = Wire.AuthorityTransferProbe
type Imported = Wire.AuthorityTransferControlImportResult
type Page = Wire.AuthorityTransferControlExportPageResult
type Validation = Wire.MigrationValidation

/**
 * Facts each scenario reports. The port only drives the stores and reads back; the judge below decides
 * whether the facts meet the transfer rules, so every implementation is judged the same way. "Every
 * operation" means the eight calls with well-formed placeholder requests.
 */
export interface TransferObservations {
  /** Both descriptors; every operation of a store without maintenance; a probe of an unknown upgrade. */
  readonly select: {
    readonly maintained: Wire.ProviderDescriptor
    readonly unmaintained: Wire.ProviderDescriptor
    readonly unsupported: readonly string[]
    readonly probe: Fact<Probe>
  }
  /**
   * A full transfer: fence twice, a write and a read while fenced, export twice, the manifest walked
   * two parts at a time and its first page asked again, import twice, the candidate's write and probe,
   * verify, activation on the published route before and after the directory records it, then both
   * stores reopened: the target's probe, reads and write, the source's probe and write.
   */
  readonly normal: {
    readonly authority: Wire.StateAuthorityRef
    readonly fence: readonly Fact<Fence>[]
    readonly fenced: { readonly write: string | null; readonly serves: boolean }
    readonly export: readonly Fact<Export>[]
    readonly pages: readonly Fact<Page>[]
    readonly again: Fact<Page>
    readonly import: readonly Fact<Imported>[]
    readonly candidate: { readonly write: string | null; readonly probe: Fact<Probe> }
    readonly verify: Fact<Validation>
    readonly route: Wire.AuthorityRoute
    readonly activate: readonly Fact<Probe>[]
    readonly after: {
      readonly target: Fact<Probe>
      readonly serves: boolean
      readonly write: string | null
      readonly source: Fact<Probe>
      readonly sourceWrite: string | null
    }
  }
  /**
   * Every operation as an outsider; a second fence with other input under the same upgrade; verify of
   * a good and of a damaged candidate; activation with no published route, a forged route, a wrong
   * cutover, a stale epoch, another location's route and a published route naming another candidate's
   * checkpoint, then the candidate's probe and write; abort
   * with an unpublished recovery route, a wrong fence, a skipped epoch and after a target activated,
   * then the source's probe; an import after one exported chunk was tampered with.
   */
  readonly deny: {
    readonly outsider: readonly string[]
    readonly conflict: Fact<Fence>
    readonly verify: { readonly good: Fact<Validation>; readonly damaged: Fact<Validation> }
    readonly routes: readonly Fact<Probe>[]
    readonly candidate: { readonly probe: Fact<Probe>; readonly write: string | null }
    readonly aborts: readonly Fact<Probe>[]
    readonly source: Fact<Probe>
    readonly tampered: Fact<Imported>
  }
  /**
   * A fence and an import with an aborted context, each followed by its store's probe; a write after
   * the cancelled fence; every operation with an aborted context.
   */
  readonly cancel: {
    readonly fence: Fact<Fence>
    readonly import: Fact<Imported>
    readonly probes: readonly Fact<Probe>[]
    readonly write: string | null
    readonly every: readonly string[]
  }
  /**
   * The source reopened after fence and after export; an import interrupted mid-copy, the target
   * reopened and the import retried, beside a clean import elsewhere; the target reopened and probed,
   * then verified; abort onto the published recovery route and the source reopened and probed; the
   * source's write and reads, the target's write, and a late activation of the target.
   */
  readonly recover: {
    readonly fence: Fact<Fence>
    readonly reopened: Fact<Probe>
    readonly fencedWrite: string | null
    readonly export: readonly Fact<Export>[]
    readonly interrupted: Fact<Imported>
    readonly resumed: Fact<Imported>
    readonly clean: Fact<Imported>
    readonly imported: Fact<Probe>
    readonly verify: Fact<Validation>
    readonly aborted: readonly Fact<Probe>[]
    readonly sourceWrite: string | null
    readonly sourceServes: boolean
    readonly targetWrite: string | null
    readonly late: Fact<Probe>
  }
  /** Every operation of a closed source and a closed target. */
  readonly dispose: { readonly refusals: readonly string[] }
}

export type TransferContractPort = {
  readonly [K in ScenarioName]: (context: CaseContext) => Promise<TransferObservations[K]>
}

const maintainer = (aborted = false) => callContext('transfer-principal', TRANSFER_MAINTAINER, aborted)

function must<T>(fact: Fact<T>): T {
  if ('refused' in fact) throw new Error(`transfer step refused: ${fact.refused}`)
  return fact.value
}

const CHECKPOINT: Wire.AuthorityCheckpoint = {
  authorityId: NONE,
  authorityEpoch: 1,
  checkpointId: NONE,
  snapshotDigest: COHORT,
  recordCount: 0,
  bridgeWatermarks: [],
}
const PLACEHOLDER = inline(schema('agh.conformance/placeholder@1'), null)
const EXPORT: Export = {
  upgradeId: UPGRADE,
  fenceId: NONE,
  checkpoint: CHECKPOINT,
  collectionCount: 0,
  partCount: 0,
  manifestRoot: PLACEHOLDER,
  requiredAssetsRoot: PLACEHOLDER,
  deletionWatermark: 0,
}
const ROUTE = routeRef({
  logicalAuthorityId: NONE,
  tenantId: NONE,
  authorityEpoch: 2,
  providerBinding: { bindingId: NONE, contract: 'agh.conformance', logicalName: NONE, providerId: NONE },
  locationRef: NONE,
  cohortDigest: COHORT,
  cutoverId: NONE,
  checkpoint: CHECKPOINT,
  previous: null,
})

/** Every operation with well-formed placeholder requests: each refusal's detail code, or `accepted`. */
async function sweep(store: TransferStore, context: CallContext): Promise<string[]> {
  const control = store.control()
  const expected = { authorityId: NONE, tenantId: NONE, authorityEpoch: 1 }
  const facts = [
    await outcomeOf(() => control.fence({ upgradeId: UPGRADE, expected, cohortDigest: COHORT }, context)),
    await outcomeOf(() => control.export({ upgradeId: UPGRADE, fenceId: NONE }, context)),
    await outcomeOf(() =>
      control.exportPage(
        { upgradeId: UPGRADE, fenceId: NONE, manifestDigest: COHORT, cursor: null, limit: 1 },
        context,
      ),
    ),
    await outcomeOf(() =>
      control.import({ upgradeId: UPGRADE, source: EXPORT, targetLocationRef: NONE }, context),
    ),
    await outcomeOf(() =>
      control.verify({ upgradeId: UPGRADE, source: EXPORT, candidateRef: PLACEHOLDER }, context),
    ),
    await outcomeOf(() =>
      control.activate({ upgradeId: UPGRADE, cutoverId: NONE, publishedRoute: ROUTE }, context),
    ),
    await outcomeOf(() =>
      control.abort({ upgradeId: UPGRADE, expectedFenceId: NONE, recoveryRoute: ROUTE }, context),
    ),
    await outcomeOf(() => control.probe({ upgradeId: UPGRADE }, context)),
  ]
  return facts.map((fact) => ('refused' in fact ? fact.refused : 'accepted'))
}

/** The calls of one upgrade in one world, as the maintenance controller unless a context is given. */
function steps(world: TransferWorld) {
  const manifestDigest = (ref: Wire.DataRef) => (ref.kind === 'inline' ? ref.digest : ref.blob.digest)
  const page = (exported: Export, cursor: string | null) =>
    outcomeOf(() =>
      world.source.control().exportPage(
        {
          upgradeId: UPGRADE,
          fenceId: exported.fenceId,
          manifestDigest: manifestDigest(exported.manifestRoot),
          cursor,
          limit: PAGE_LIMIT,
        },
        maintainer(),
      ),
    )
  /** The route at `locationRef` serving `checkpoint`, at the epoch after the fence unless `over` names one. */
  const route = (
    fence: Fence,
    checkpoint: Wire.AuthorityCheckpoint,
    locationRef: Wire.Id,
    over: Partial<Wire.AuthorityRoute> = {},
  ): Wire.AuthorityRoute => ({
    logicalAuthorityId: fence.source.authorityId,
    tenantId: fence.source.tenantId,
    authorityEpoch: fence.fenceEpoch + 1,
    providerBinding: world.providerBinding,
    locationRef,
    cohortDigest: COHORT,
    cutoverId: CUTOVER,
    checkpoint,
    previous: { authorityEpoch: fence.fenceEpoch, locationRef: world.locationRef, cutoverId: NONE },
    ...over,
  })
  return {
    fence: (cohortDigest = COHORT, context = maintainer()) =>
      outcomeOf(() =>
        world.source
          .control()
          .fence({ upgradeId: UPGRADE, expected: world.authority, cohortDigest }, context),
      ),
    export: (fence: Fence) =>
      outcomeOf(() =>
        world.source.control().export({ upgradeId: UPGRADE, fenceId: fence.fenceId }, maintainer()),
      ),
    page,
    /** Follows the cursor to the end; a walk longer than one page per part is cut off there. */
    async walk(exported: Export) {
      const pages: Fact<Page>[] = []
      let cursor: string | null = null
      for (let turn = 0; turn <= exported.partCount; turn += 1) {
        const fact = await page(exported, cursor)
        pages.push(fact)
        if ('refused' in fact || fact.value.nextCursor === null) break
        cursor = fact.value.nextCursor
      }
      return pages
    },
    import: (store: TransferStore, source: Export, targetLocationRef: Wire.Id, context = maintainer()) =>
      outcomeOf(() => store.control().import({ upgradeId: UPGRADE, source, targetLocationRef }, context)),
    verify: (store: TransferStore, source: Export, candidateRef: Wire.DataRef) =>
      outcomeOf(() => store.control().verify({ upgradeId: UPGRADE, source, candidateRef }, maintainer())),
    activate: (store: TransferStore, route: Wire.AuthorityRoute, cutoverId = route.cutoverId) =>
      outcomeOf(() =>
        store
          .control()
          .activate({ upgradeId: UPGRADE, cutoverId, publishedRoute: routeRef(route) }, maintainer()),
      ),
    abort: (fence: Fence, route: Wire.AuthorityRoute, expectedFenceId = fence.fenceId) =>
      outcomeOf(() =>
        world.source
          .control()
          .abort({ upgradeId: UPGRADE, expectedFenceId, recoveryRoute: routeRef(route) }, maintainer()),
      ),
    probe: (store: TransferStore) =>
      outcomeOf(() => store.control().probe({ upgradeId: UPGRADE }, maintainer())),
    route,
    /** The route activating an imported candidate: its target checkpoint re-stamped at the route's epoch. */
    serving(fence: Fence, imported: Imported, locationRef: Wire.Id, over: Partial<Wire.AuthorityRoute> = {}) {
      const authorityEpoch = over.authorityEpoch ?? fence.fenceEpoch + 1
      return route(fence, { ...imported.targetCheckpoint, authorityEpoch }, locationRef, over)
    },
  }
}

/** Drives one subject through the six scenarios, each in a fresh world that is disposed afterwards. */
export function transferContractPort(subject: TransferSubject): TransferContractPort {
  const within =
    <T>(body: (world: TransferWorld) => Promise<T>) =>
    async () => {
      const world = await subject.open(true)
      try {
        return await body(world)
      } finally {
        await world.dispose()
      }
    }
  return {
    async select() {
      const plain = await subject.open(false)
      const world = await subject.open(true)
      try {
        return {
          maintained: world.descriptor,
          unmaintained: plain.descriptor,
          unsupported: await sweep(plain.source, maintainer()),
          probe: await steps(world).probe(world.source),
        }
      } finally {
        await plain.dispose()
        await world.dispose()
      }
    },
    normal: within(async (world) => {
      const run = steps(world)
      const fence = [await run.fence(), await run.fence()]
      const fenced = must(fence[0] as Fact<Fence>)
      const whileFenced = { write: await world.source.write(), serves: await world.source.serves() }
      const exports = [await run.export(fenced), await run.export(fenced)]
      const exported = must(exports[0] as Fact<Export>)
      const pages = await run.walk(exported)
      const target = await world.target(TARGET)
      const imports = [await run.import(target, exported, TARGET), await run.import(target, exported, TARGET)]
      const imported = must(imports[0] as Fact<Imported>)
      const candidate = { write: await target.write(), probe: await run.probe(target) }
      const verify = await run.verify(target, exported, imported.candidateRef)
      const route = run.serving(fenced, imported, TARGET)
      world.publish(route, false)
      const activate = [await run.activate(target, route)]
      world.publish(route, true)
      activate.push(await run.activate(target, route))
      await target.reopen()
      await world.source.reopen()
      return {
        authority: world.authority,
        fence,
        fenced: whileFenced,
        export: exports,
        pages,
        again: await run.page(exported, null),
        import: imports,
        candidate,
        verify,
        route,
        activate,
        after: {
          target: await run.probe(target),
          serves: await target.serves(),
          write: await target.write(),
          source: await run.probe(world.source),
          sourceWrite: await world.source.write(),
        },
      }
    }),
    deny: within(async (world) => {
      const run = steps(world)
      const fence = must(await run.fence())
      const conflict = await run.fence(OTHER_COHORT)
      const exported = must(await run.export(fence))
      const outsider = await sweep(world.source, callContext('transfer-principal', 'transfer-outsider'))
      const good = await world.target('conformance-good')
      const bad = await world.target('conformance-bad')
      const imported = must(await run.import(good, exported, 'conformance-good'))
      const damaged = must(await run.import(bad, exported, 'conformance-bad'))
      await world.damage('conformance-bad')
      const verify = {
        good: await run.verify(good, exported, imported.candidateRef),
        damaged: await run.verify(bad, exported, damaged.candidateRef),
      }
      const route = run.serving(fence, imported, 'conformance-good')
      const stale = run.serving(fence, imported, 'conformance-good', { authorityEpoch: fence.fenceEpoch })
      const elsewhere = run.serving(fence, damaged, 'conformance-bad')
      const foreign = {
        ...route,
        checkpoint: { ...route.checkpoint, checkpointId: 'conformance-other-candidate' },
      }
      const routes = [await run.activate(good, route)]
      world.publish(route, false)
      routes.push(await run.activate(good, { ...route, cohortDigest: OTHER_COHORT }))
      routes.push(await run.activate(good, route, 'conformance-other-cutover'))
      world.publish(stale, false)
      routes.push(await run.activate(good, stale))
      world.publish(elsewhere, false)
      routes.push(await run.activate(good, elsewhere))
      world.publish(foreign, false)
      routes.push(await run.activate(good, foreign))
      const candidate = { probe: await run.probe(good), write: await good.write() }
      const recovery = run.route(fence, fence.checkpoint, world.locationRef, { cutoverId: RECOVERY })
      const skipped = { ...recovery, authorityEpoch: fence.fenceEpoch + 2 }
      const aborts = [await run.abort(fence, recovery)]
      world.publish(recovery, false)
      aborts.push(await run.abort(fence, recovery, 'conformance-other-fence'))
      world.publish(skipped, false)
      aborts.push(await run.abort(fence, skipped))
      world.publish(recovery, true)
      aborts.push(await run.abort(fence, recovery))
      const source = await run.probe(world.source)
      const part = must(await run.page(exported, null)).items[0]
      if (part === undefined) throw new Error('the export has no parts')
      await world.tamper(part.chunk)
      const tampered = await run.import(
        await world.target('conformance-tampered'),
        exported,
        'conformance-tampered',
      )
      return { outsider, conflict, verify, routes, candidate, aborts, source, tampered }
    }),
    cancel: within(async (world) => {
      const run = steps(world)
      const aborted = maintainer(true)
      const fence = await run.fence(COHORT, aborted)
      const probes = [await run.probe(world.source)]
      const write = await world.source.write()
      const exported = must(await run.export(must(await run.fence())))
      const target = await world.target(TARGET)
      const imported = await run.import(target, exported, TARGET, aborted)
      probes.push(await run.probe(target))
      return { fence, import: imported, probes, write, every: await sweep(world.source, aborted) }
    }),
    recover: within(async (world) => {
      const run = steps(world)
      const fence = await run.fence()
      const fenced = must(fence)
      await world.source.reopen()
      const reopened = await run.probe(world.source)
      const fencedWrite = await world.source.write()
      const exports = [await run.export(fenced)]
      const exported = must(exports[0] as Fact<Export>)
      await world.source.reopen()
      exports.push(await run.export(fenced))
      const target = await world.target(TARGET)
      world.cut(INTERRUPT_AFTER)
      const interrupted = await run.import(target, exported, TARGET)
      world.cut(null)
      await target.reopen()
      const resumed = await run.import(target, exported, TARGET)
      const clean = await run.import(await world.target('conformance-clean'), exported, 'conformance-clean')
      await target.reopen()
      const imported = await run.probe(target)
      const candidate = must(resumed)
      const verify = await run.verify(target, exported, candidate.candidateRef)
      const recovery = run.route(fenced, fenced.checkpoint, world.locationRef, { cutoverId: RECOVERY })
      world.publish(recovery, false)
      const aborted = [await run.abort(fenced, recovery)]
      await world.source.reopen()
      aborted.push(await run.probe(world.source))
      return {
        fence,
        reopened,
        fencedWrite,
        export: exports,
        interrupted,
        resumed,
        clean,
        imported,
        verify,
        aborted,
        sourceWrite: await world.source.write(),
        sourceServes: await world.source.serves(),
        targetWrite: await target.write(),
        late: await run.activate(target, run.serving(fenced, candidate, TARGET)),
      }
    }),
    dispose: within(async (world) => {
      const target = await world.target(TARGET)
      await world.source.close()
      await target.close()
      return {
        refusals: [...(await sweep(world.source, maintainer())), ...(await sweep(target, maintainer()))],
      }
    }),
  }
}

const valued = <T>(fact: Fact<T> | undefined): T | undefined =>
  fact && 'value' in fact ? fact.value : undefined
const valid = (name: keyof RuntimeWireTypes, value: unknown) => validateRuntime(name, value).ok

/** A refusal (or a write's refusal code) whose class is one of `classes`. */
function refusedAs(fact: Fact<unknown> | string | null | undefined, ...classes: string[]): boolean {
  const detail = typeof fact === 'string' ? fact : fact && 'refused' in fact ? fact.refused : undefined
  if (detail === undefined || !Object.hasOwn(RuntimeErrorDetails, detail)) return false
  return classes.includes((RuntimeErrorDetails as Record<string, { code: string }>)[detail]?.code ?? '')
}

const order = (left: Wire.AuthorityExportPart, right: Wire.AuthorityExportPart) =>
  Buffer.compare(Buffer.from(left.collectionId), Buffer.from(right.collectionId)) ||
  left.partIndex - right.partIndex

/** Pages of at most the limit, each but the last with a cursor, covering every part once in part order. */
function walked(pages: readonly Fact<Page>[], exported: Export): boolean {
  const values = pages.map(valued)
  if (values.length === 0 || values.some((page) => page === undefined)) return false
  const complete = values as Page[]
  const parts = complete.flatMap((page) => page.items)
  return (
    complete.every((page, index) =>
      index === complete.length - 1
        ? page.complete && page.nextCursor === null
        : !page.complete && page.nextCursor !== null && page.items.length > 0,
    ) &&
    complete.every((page) => page.items.length <= PAGE_LIMIT && page.snapshot === complete[0]?.snapshot) &&
    parts.length === exported.partCount &&
    parts.every(
      (part, index) =>
        valid('AuthorityExportPart', part) &&
        (index === 0 || order(parts[index - 1] as Wire.AuthorityExportPart, part) < 0),
    ) &&
    new Set(parts.map((part) => part.collectionId)).size === exported.collectionCount
  )
}

function importedProbe(fact: Fact<Probe>, fence: Fence, imported: Imported): boolean {
  const probe = valued(fact)
  return (
    probe?.state === 'imported' &&
    probe.fence.fenceId === fence.fenceId &&
    probe.fence.upgradeId === UPGRADE &&
    HEX.test(probe.exportDigest) &&
    same(probe.targetCheckpoint, imported.targetCheckpoint)
  )
}

function validation(fact: Fact<Validation>, accepted: boolean): boolean {
  const value = valued(fact)
  return (
    value !== undefined &&
    valid('MigrationValidation', value) &&
    value.upgradeId === UPGRADE &&
    value.accepted === accepted &&
    value.checks.every((check) => check.passed) === accepted
  )
}

const JUDGE: Judge<TransferObservations> = {
  select: (seen) => {
    const offered = (descriptor: Wire.ProviderDescriptor) => descriptor.operations.map((item) => item.method)
    return (
      valid('ProviderDescriptor', seen.maintained) &&
      valid('ProviderDescriptor', seen.unmaintained) &&
      seen.maintained.features.includes(FEATURE) &&
      OPERATIONS.every((operation) => offered(seen.maintained).includes(operation)) &&
      !seen.unmaintained.features.includes(FEATURE) &&
      !offered(seen.unmaintained).some((operation) => OPERATIONS.includes(operation)) &&
      seen.unsupported.length === OPERATIONS.length &&
      seen.unsupported.every((detail) => detail === 'operation_not_supported') &&
      same(seen.probe, { value: { state: 'absent' } })
    )
  },
  normal: (seen) => {
    const fence = valued(seen.fence[0])
    const exported = valued(seen.export[0])
    const imported = valued(seen.import[0])
    const observed = valued(seen.activate[0])
    if (fence === undefined || exported === undefined || imported === undefined || observed === undefined)
      return false
    const activated = {
      state: 'activated',
      cutoverId: seen.route.cutoverId,
      authority: { ...seen.authority, authorityEpoch: fence.fenceEpoch + 1 },
      checkpoint: seen.route.checkpoint,
    }
    return (
      valid('AuthorityFence', fence) &&
      same(seen.fence[1], seen.fence[0]) &&
      same(fence.source, seen.authority) &&
      fence.fenceEpoch === seen.authority.authorityEpoch &&
      fence.checkpoint.authorityId === seen.authority.authorityId &&
      fence.writerCredentialsRevoked &&
      refusedAs(seen.fenced.write, 'denied') &&
      seen.fenced.serves &&
      valid('AuthorityExport', exported) &&
      same(seen.export[1], seen.export[0]) &&
      exported.fenceId === fence.fenceId &&
      same(exported.checkpoint, fence.checkpoint) &&
      exported.manifestRoot.schema.typeId === 'agh.migration/export-index@1' &&
      exported.requiredAssetsRoot.schema.typeId === 'agh.migration/asset-index@1' &&
      walked(seen.pages, exported) &&
      same(seen.again, seen.pages[0]) &&
      valid('AuthorityTransferControlImportResult', imported) &&
      same(seen.import[1], seen.import[0]) &&
      imported.targetCheckpoint.authorityId === seen.authority.authorityId &&
      seen.candidate.write !== null &&
      importedProbe(seen.candidate.probe, fence, imported) &&
      validation(seen.verify, true) &&
      same(seen.activate, [{ value: activated }, { value: activated }]) &&
      observed.state === 'activated' &&
      observed.checkpoint.authorityEpoch === observed.authority.authorityEpoch &&
      same(seen.after.target, { value: activated }) &&
      seen.after.serves &&
      seen.after.write === null &&
      same(seen.after.source, { value: { state: 'fenced', fence } }) &&
      refusedAs(seen.after.sourceWrite, 'denied')
    )
  },
  deny: (seen) =>
    seen.outsider.length === OPERATIONS.length &&
    seen.outsider.every((detail) => detail === 'permission_denied') &&
    same(seen.conflict, { refused: 'idempotency_conflict' }) &&
    validation(seen.verify.good, true) &&
    validation(seen.verify.damaged, false) &&
    seen.routes.length === 6 &&
    seen.routes.every((fact) => refusedAs(fact, 'conflict', 'invalid_input')) &&
    valued(seen.candidate.probe)?.state === 'imported' &&
    seen.candidate.write !== null &&
    seen.aborts.length === 4 &&
    seen.aborts.every((fact) => refusedAs(fact, 'conflict', 'invalid_input')) &&
    valued(seen.source)?.state === 'fenced' &&
    same(seen.tampered, { refused: 'integrity' }),
  cancel: (seen) =>
    same([seen.fence, seen.import], [{ refused: 'cancelled' }, { refused: 'cancelled' }]) &&
    same(seen.probes, [{ value: { state: 'absent' } }, { value: { state: 'absent' } }]) &&
    seen.write === null &&
    seen.every.length === OPERATIONS.length &&
    seen.every.every((detail) => detail === 'cancelled'),
  recover: (seen) => {
    const fence = valued(seen.fence)
    const resumed = valued(seen.resumed)
    const clean = valued(seen.clean)
    if (fence === undefined || resumed === undefined || clean === undefined) return false
    const aborted = { state: 'aborted', source: fence.source, restoredEpoch: fence.fenceEpoch + 1 }
    return (
      same(seen.reopened, { value: { state: 'fenced', fence } }) &&
      refusedAs(seen.fencedWrite, 'denied') &&
      valued(seen.export[0]) !== undefined &&
      same(seen.export[1], seen.export[0]) &&
      'refused' in seen.interrupted &&
      resumed.targetCheckpoint.snapshotDigest === clean.targetCheckpoint.snapshotDigest &&
      resumed.targetCheckpoint.recordCount === clean.targetCheckpoint.recordCount &&
      importedProbe(seen.imported, fence, resumed) &&
      validation(seen.verify, true) &&
      same(seen.aborted, [{ value: aborted }, { value: aborted }]) &&
      seen.sourceWrite === null &&
      seen.sourceServes &&
      seen.targetWrite !== null &&
      refusedAs(seen.late, 'conflict', 'invalid_input')
    )
  },
  dispose: (seen) =>
    seen.refusals.length === OPERATIONS.length * 2 && seen.refusals.every((detail) => detail === 'blocked'),
}

const FEATURES: Record<ScenarioName, readonly string[]> = {
  select: [FEATURE],
  normal: ['fence', 'export', 'exportPage', 'import', 'verify', 'activate', 'probe'],
  deny: Object.keys(RuntimeAuthorityTransferAPI.methods),
  cancel: Object.keys(RuntimeAuthorityTransferAPI.methods),
  recover: ['fence', 'export', 'import', 'verify', 'activate', 'abort', 'probe'],
  dispose: Object.keys(RuntimeAuthorityTransferAPI.methods),
}

/**
 * Registers the six authority transfer cases of one provider under `contract`, beside that contract's
 * own cases, for any service that declares the feature.
 */
export function registerAuthorityTransferContract(
  harness: ConformanceHarness,
  contract: string,
  binding: ConformanceBinding<TransferContractPort>,
): void {
  registerScenarios<TransferObservations>(harness, contract, binding, JUDGE, FEATURES, {
    name: 'authority-transfer',
    methodKind: 'maintenance',
  })
}

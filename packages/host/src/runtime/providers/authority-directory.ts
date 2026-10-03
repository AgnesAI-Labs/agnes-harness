import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryCompareAndSwapResult,
  AuthorityDirectoryReadRequest,
  AuthorityDirectoryReadResult,
  AuthorityRoute,
  DataRef,
  JsonValue,
  MigrationReceipt,
  MigrationRequest,
  RuntimeError,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync, syncFileSync } from '@agnes/system-node'
import {
  activateHead,
  type DirectoryHead,
  decidePublication,
  decideRead,
  emptyHead,
  fenceHead,
  type PublicationRefusal,
  retargetLocator,
  seedHead,
  unfenceHead,
} from '../maintenance/authority-publication.js'
import {
  authorityDurability,
  type BootstrapAnchor,
  type BootstrapLocator,
  createBootstrapAnchor,
  filesystemSupportsLocalRename,
  openBootstrapAnchor,
  pathsAreSeparate,
  readStageZero,
  replaceAuthorityFileSync,
  type StageZeroView,
  syncAuthorityDirectorySync,
} from '../maintenance/bootstrap-locator.js'

export const AUTHORITY_DIRECTORY_CONTRACT = 'agh.authority-directory' as const
export const AUTHORITY_DIRECTORY_PROVIDER_ID = 'agh.default/authority-directory' as const

export const DURABILITY_PHASES = ['temp', 'fsync', 'rename', 'commit', 'notify'] as const
export type DurabilityPhase = (typeof DURABILITY_PHASES)[number]

export interface AuthorityDirectoryOpenOptions {
  readonly directory: string
  readonly anchor: string
  readonly authority: StateAuthorityRef
  readonly filesystem?: 'local' | 'unsupported'
  readonly onPhase?: (phase: DurabilityPhase) => void
}

export interface UpgradeApproval {
  readonly upgradeId: string
  readonly validationRef: DataRef
  readonly authorityIds: readonly string[]
}

export interface ActivationNote {
  readonly logicalAuthorityId: string
  readonly authorityEpoch: number
  readonly cutoverId: string
}

export interface AuthorityDirectoryProvider {
  readonly providerId: typeof AUTHORITY_DIRECTORY_PROVIDER_ID
  readonly contract: typeof AUTHORITY_DIRECTORY_CONTRACT
  readonly features: readonly string[]
  read(
    request: AuthorityDirectoryReadRequest,
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryReadResult>>
  compareAndSwap(
    request: AuthorityDirectoryCompareAndSwapRequest,
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryCompareAndSwapResult>>
  transfer(request: MigrationRequest, context: CallContext): Promise<Outcome<MigrationReceipt>>
  seedRoute(route: AuthorityRoute, context: CallContext): Promise<Outcome<{ readonly revision: number }>>
  approveUpgrade(
    input: UpgradeApproval,
    context: CallContext,
  ): Promise<Outcome<{ readonly upgradeId: string }>>
  recordActivation(input: ActivationNote, context: CallContext): Promise<Outcome<{ readonly recorded: true }>>
  freeze(context: CallContext): Promise<Outcome<{ readonly fenced: true }>>
  releaseFreeze(context: CallContext): Promise<Outcome<{ readonly fenced: false }>>
  probeCutover(
    cutoverId: string,
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryCompareAndSwapResult | { readonly state: 'absent' }>>
  dispose(): Promise<void>
}

interface GenerationDocument {
  readonly id: string
  readonly head: DirectoryHead
  readonly fingerprint: string | null
  readonly result: AuthorityDirectoryCompareAndSwapResult | null
  readonly approval?: UpgradeApproval
  readonly origins?: readonly { readonly domainId: string; readonly digest: string }[]
}

interface HeldGeneration {
  readonly id: string | null
  readonly head: DirectoryHead
}

class PhaseStop extends Error {
  readonly phase: DurabilityPhase
  constructor(phase: DurabilityPhase) {
    super(`durability phase ${phase}`)
    this.phase = phase
  }
}

export function createAuthorityDirectoryProvider(
  options: AuthorityDirectoryOpenOptions,
): AuthorityDirectoryProvider {
  const directory = resolve(options.directory)
  const anchor = resolve(options.anchor)
  let disposed = false
  const localFs =
    options.filesystem !== 'unsupported' &&
    filesystemSupportsLocalRename(directory) &&
    filesystemSupportsLocalRename(anchor)
  const fileFlush = authorityDurability() === 'windows-file-flush'
  const features: readonly string[] = localFs
    ? [
        'cutover-replay',
        'external-anchor',
        'local-fs-rename',
        'exclusive-lock',
        ...(fileFlush ? ['windows-file-flush'] : []),
      ]
    : ['cutover-replay', 'external-anchor']

  function refused<T>(refusal: PublicationRefusal): Outcome<T> {
    return {
      ok: false,
      error: {
        code: refusal.code,
        detailCode: refusal.detailCode,
        message: 'Authority directory refused the request',
        retryAdvice: { kind: refusal.code === 'retryable' ? 'retry_same_action' : 'never' },
        diagnosticId: 'authority-directory',
      },
    }
  }

  function precheck(context: CallContext): Outcome<never> | null {
    if (disposed) return refused({ code: 'denied', detailCode: 'directory_disposed' })
    if (!pathsAreSeparate(directory, anchor))
      return refused({ code: 'incompatible', detailCode: 'anchor_nested' })
    if (!localFs) return refused({ code: 'incompatible', detailCode: 'filesystem_unsupported' })
    if (context.signal.aborted) return refused({ code: 'cancelled', detailCode: 'directory_cancelled' })
    return null
  }

  function authorize(context: CallContext): Outcome<StageZeroView> {
    const opened = readStageZero(anchor)
    if (!opened.ok) return opened
    if (!opened.value) return refused({ code: 'incompatible', detailCode: 'anchor_absent' })
    if (opened.value.credential.principalRef !== context.principalRef) {
      return refused({ code: 'denied', detailCode: 'maintenance_principal' })
    }
    if (opened.value.credential.directoryId !== opened.value.locator.directoryId) {
      return refused({ code: 'incompatible', detailCode: 'anchor_corrupt' })
    }
    return { ok: true, value: opened.value }
  }

  async function gate(
    context: CallContext,
    request: unknown,
    schema: Parameters<typeof validateRuntime>[0] | null,
  ): Promise<Outcome<StageZeroView>> {
    const early = precheck(context)
    if (early) return early
    if (schema !== null) {
      const parsed = validateRuntime(schema, request)
      if (!parsed.ok) return refused({ code: 'invalid_input', detailCode: 'schema' })
    }
    return authorize(context)
  }

  function blankHead(locator: BootstrapLocator): DirectoryHead {
    return emptyHead(options.authority, locator.epoch)
  }

  function prepareHead(view: StageZeroView): Outcome<DirectoryHead> {
    if (view.locator.endpointRef !== directory)
      return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
    const loaded = loadHead(directory, options.authority, view.locator)
    if (!loaded.ok) return loaded
    if (loaded.value.locatorEpoch === view.locator.epoch) return loaded
    return adoptPublishedHead(directory, anchor, loaded.value, view.locator, options.onPhase)
  }

  function aligned(
    current: HeldGeneration,
    locator: BootstrapLocator,
    context: CallContext,
  ): Outcome<DirectoryHead> {
    const live = authorize(context)
    if (!live.ok) return live
    if (
      live.value.locator.epoch !== locator.epoch ||
      live.value.locator.revision !== locator.revision ||
      live.value.locator.endpointRef !== locator.endpointRef
    )
      return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
    const head = current.head
    if (
      head.authority.authorityId !== options.authority.authorityId ||
      head.authority.tenantId !== options.authority.tenantId
    ) {
      return refused({ code: 'conflict', detailCode: 'directory_authority' })
    }
    if (locator.endpointRef !== directory || locator.epoch !== head.locatorEpoch) {
      return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
    }
    return { ok: true, value: head }
  }

  function finish<T>(value: T): Outcome<T> {
    try {
      options.onPhase?.('notify')
    } catch (error) {
      if (error instanceof PhaseStop) throw error
      throw new PhaseStop('notify')
    }
    return { ok: true, value }
  }

  function publish(previousId: string | null, document: GenerationDocument): Outcome<true> {
    return writeGeneration(directory, previousId, document, options.onPhase)
  }

  return {
    providerId: AUTHORITY_DIRECTORY_PROVIDER_ID,
    contract: AUTHORITY_DIRECTORY_CONTRACT,
    features,
    async read(request, context) {
      const gated = await gate(context, request, 'AuthorityDirectoryReadRequest')
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        const decision = decideRead(head.value, request, (id, digest) => hasOrigin(directory, id, digest))
        if (decision.kind === 'refuse') return refused(decision.refusal)
        return { ok: true as const, value: decision.value }
      })
    },
    async compareAndSwap(request, context) {
      const gated = await gate(context, request, 'AuthorityDirectoryCompareAndSwapRequest')
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      const outcome = mutate<{
        readonly published: boolean
        readonly result: AuthorityDirectoryCompareAndSwapResult
      }>(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        const existing = readCommitted(directory, request.publication.cutoverId)
        const decision = decidePublication(
          head.value,
          request,
          existing,
          readApproval(directory, request.publication.upgradeId),
        )
        if (decision.kind === 'refuse') return refused(decision.refusal)
        if (decision.kind === 'replay') {
          return { ok: true as const, value: { published: false as const, result: decision.result } }
        }
        const written = publish(current.id, {
          id: `publication:${request.publication.cutoverId}`,
          head: decision.head,
          fingerprint: decision.fingerprint,
          result: decision.result,
          origins: request.publication.jointDispatchMappings.flatMap((mapping) =>
            [mapping.from, mapping.to].map((qualification) => ({
              domainId: mapping.domainId,
              digest: canonicalJsonDigest(JSON.parse(JSON.stringify(qualification)) as JsonValue),
            })),
          ),
        })
        if (!written.ok) return written
        return { ok: true as const, value: { published: true as const, result: decision.result } }
      })
      if (!outcome.ok) return outcome
      if (!outcome.value.published) return { ok: true, value: outcome.value.result }
      return finish(outcome.value.result)
    },
    async transfer(request, context) {
      const gated = await gate(context, request, 'MigrationRequest')
      if (!gated.ok) return gated
      if (request.target.kind !== 'directory')
        return refused({ code: 'incompatible', detailCode: 'transfer_kind_unsupported' })
      if (request.mode === 'auto-compatible')
        return refused({ code: 'incompatible', detailCode: 'transfer_mode_unsupported' })
      if (request.mode === 'inspect-only') {
        const prepared = prepareHead(gated.value)
        const blocked = !prepared.ok || prepared.value.fenced
        return {
          ok: true,
          value: receipt(
            request.upgradeId,
            blocked ? 'blocked' : 'planned',
            gated.value.locator.revision,
            null,
          ),
        }
      }
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return publishDirectoryMove(directory, anchor, options, gated.value, request, context, refused)
    },
    async seedRoute(route, context) {
      const gated = await gate(context, route, 'AuthorityRoute')
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        if (head.value.fenced) return refused({ code: 'conflict', detailCode: 'directory_fenced' })
        const seeded = seedHead(head.value, route)
        if (!isHead(seeded)) return refused(seeded)
        const id = `seed:${canonicalJsonDigest(route.logicalAuthorityId)}`
        const written = publish(current.id, { id, head: seeded, fingerprint: null, result: null })
        if (!written.ok) return written
        return { ok: true as const, value: { revision: 1 } }
      })
    },
    async approveUpgrade(input, context) {
      const gated = await gate(context, input.validationRef, 'DataRef')
      if (!gated.ok) return gated
      if (!validateRuntime('Id', input.upgradeId).ok)
        return refused({ code: 'invalid_input', detailCode: 'schema' })
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        if (head.value.fenced) return refused({ code: 'conflict', detailCode: 'directory_fenced' })
        if (readApproval(directory, input.upgradeId))
          return refused({ code: 'conflict', detailCode: 'upgrade_exists' })
        if (
          input.authorityIds.length === 0 ||
          new Set(input.authorityIds).size !== input.authorityIds.length
        ) {
          return refused({ code: 'invalid_input', detailCode: 'journal_authorities' })
        }
        const id = `approval:${canonicalJsonDigest(input.upgradeId)}`
        const written = publish(current.id, {
          id,
          head: head.value,
          approval: input,
          fingerprint: null,
          result: null,
        })
        if (!written.ok) return written
        return { ok: true as const, value: { upgradeId: input.upgradeId } }
      })
    },
    async recordActivation(input, context) {
      const gated = await gate(context, null, null)
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        if (head.value.fenced) return refused({ code: 'conflict', detailCode: 'directory_fenced' })
        const next = activateHead(head.value, input)
        if (!isHead(next)) return refused(next)
        if (next === head.value) return { ok: true as const, value: { recorded: true as const } }
        const id = `activation-${canonicalJsonDigest(JSON.stringify(input)).slice(0, 32)}`
        const written = publish(current.id, { id, head: next, fingerprint: null, result: null })
        if (!written.ok) return written
        return { ok: true as const, value: { recorded: true as const } }
      })
    },
    async freeze(context) {
      const gated = await gate(context, null, null)
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        const next = fenceHead(head.value)
        if (next === head.value) return { ok: true as const, value: { fenced: true as const } }
        const written = publish(current.id, {
          id: `fence-${randomUUID()}`,
          head: next,
          fingerprint: null,
          result: null,
        })
        if (!written.ok) return written
        return { ok: true as const, value: { fenced: true as const } }
      })
    },
    async releaseFreeze(context) {
      const gated = await gate(context, null, null)
      if (!gated.ok) return gated
      if (gated.value.locator.endpointRef !== directory)
        return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      return mutate(directory, blankHead(gated.value.locator), (current) => {
        const head = aligned(current, gated.value.locator, context)
        if (!head.ok) return head
        if (head.value.migrationId !== null)
          return refused({ code: 'conflict', detailCode: 'directory_fenced' })
        const next = unfenceHead(head.value)
        if (next === head.value) return { ok: true as const, value: { fenced: false as const } }
        const written = publish(current.id, {
          id: `unfence-${randomUUID()}`,
          head: next,
          fingerprint: null,
          result: null,
        })
        if (!written.ok) return written
        return { ok: true as const, value: { fenced: false as const } }
      })
    },
    async probeCutover(cutoverId, context) {
      const gated = await gate(context, cutoverId, 'Id')
      if (!gated.ok) return gated
      const prepared = prepareHead(gated.value)
      if (!prepared.ok) return prepared
      const found = readCommitted(directory, cutoverId)
      if (!found) return { ok: true, value: { state: 'absent' } }
      return { ok: true, value: found.result }
    },
    async dispose() {
      disposed = true
    },
  }
}

export function createDirectoryAnchor(
  anchor: string,
  locator: BootstrapLocator,
  principalRef: string,
): Outcome<BootstrapAnchor> {
  return createBootstrapAnchor(anchor, { locator, principalRef })
}

function publishDirectoryMove(
  directory: string,
  anchor: string,
  options: AuthorityDirectoryOpenOptions,
  view: StageZeroView,
  migration: MigrationRequest,
  context: CallContext,
  refused: <T>(refusal: PublicationRefusal) => Outcome<T>,
): Outcome<MigrationReceipt> {
  if (migration.target.kind !== 'directory')
    return refused({ code: 'incompatible', detailCode: 'transfer_kind_unsupported' })
  const target = migration.target
  if (view.locator.revision !== target.sourceLocatorRevision)
    return refused({ code: 'conflict', detailCode: 'locator_revision' })
  if (view.locator.endpointRef !== directory)
    return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
  const standby = resolve(directory, '..', 'standby', target.targetLocationRef)
  if (
    !pathsAreSeparate(directory, standby) ||
    !pathsAreSeparate(directory, anchor) ||
    !pathsAreSeparate(standby, anchor)
  ) {
    return refused({ code: 'incompatible', detailCode: 'anchor_nested' })
  }
  if (!filesystemSupportsLocalRename(standby))
    return refused({ code: 'incompatible', detailCode: 'filesystem_unsupported' })
  const frozen = mutate<DirectoryHead>(
    directory,
    emptyHead(options.authority, view.locator.epoch),
    (current) => {
      if (current.head.locatorEpoch !== view.locator.epoch)
        return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
      const live = readStageZero(anchor)
      if (!live.ok) return live
      if (!live.value || live.value.credential.principalRef !== context.principalRef)
        return refused({ code: 'denied', detailCode: 'maintenance_principal' })
      if (live.value.locator.epoch !== view.locator.epoch || live.value.locator.endpointRef !== directory)
        return refused({ code: 'conflict', detailCode: 'locator_uncertain' })
      if (current.head.migrationId !== null && current.head.migrationId !== migration.upgradeId)
        return refused({ code: 'conflict', detailCode: 'directory_fenced' })
      const next = { ...fenceHead(current.head), migrationId: migration.upgradeId }
      if (current.head.migrationId === migration.upgradeId) return { ok: true as const, value: next }
      const written = writeGeneration(
        directory,
        current.id,
        { id: `fence-move-${migration.upgradeId}`, head: next, fingerprint: null, result: null },
        options.onPhase,
      )
      if (!written.ok) return written
      return { ok: true as const, value: next }
    },
  )
  if (!frozen.ok) return frozen
  const headDigest = canonicalJsonDigest(JSON.parse(JSON.stringify(frozen.value)) as JsonValue)
  try {
    if (existsSync(standby)) return refused({ code: 'incompatible', detailCode: 'target_exists' })
    copyStore(directory, standby)
  } catch {
    return refused({ code: 'retryable', detailCode: 'durability_failed' })
  }
  const handle = openBootstrapAnchor(anchor)
  if (!handle.ok) return handle
  const journalBody = {
    upgradeId: migration.upgradeId,
    journalRef: target.externalJournalRef,
    fromEndpoint: directory,
    toEndpoint: standby,
    fromEpoch: view.locator.epoch,
    toEpoch: view.locator.epoch + 1,
    headDigest,
  }
  const journal = handle.value.writeJournal(migration.upgradeId, journalBody)
  if (!journal.ok) return journal
  if (target.externalJournalRef !== migration.upgradeId) {
    const alias = handle.value.writeJournal(target.externalJournalRef, journalBody)
    if (!alias.ok) return alias
  }
  const nextLocator: BootstrapLocator = {
    directoryId: view.locator.directoryId,
    providerLockRef: target.targetProviderLock,
    endpointRef: standby,
    epoch: view.locator.epoch + 1,
    revision: view.locator.revision + 1,
    cutoverId: migration.upgradeId,
  }
  const swapped = handle.value.compareAndSwap(view.locator.revision, nextLocator)
  if (!swapped.ok) return swapped
  const adopted = adoptPublishedHead(standby, anchor, frozen.value, nextLocator, options.onPhase)
  if (!adopted.ok) return adopted
  return {
    ok: true,
    value: receipt(migration.upgradeId, 'committed', nextLocator.revision, migration.upgradeId),
  }
}

function adoptPublishedHead(
  directory: string,
  anchor: string,
  head: DirectoryHead,
  locator: BootstrapLocator,
  onPhase: AuthorityDirectoryOpenOptions['onPhase'],
): Outcome<DirectoryHead> {
  const opened = openBootstrapAnchor(anchor)
  if (!opened.ok) return opened
  const journal = opened.value.readJournal(locator.cutoverId)
  if (!journal.ok) return journal
  const digest = canonicalJsonDigest(JSON.parse(JSON.stringify(head)) as JsonValue)
  const recorded = moveJournal(journal.value)
  if (
    !recorded ||
    recorded.toEndpoint !== directory ||
    recorded.toEpoch !== locator.epoch ||
    recorded.headDigest !== digest
  ) {
    return { ok: false, error: refusal('conflict', 'locator_uncertain') }
  }
  return mutate(directory, head, (current) => {
    if (current.head.locatorEpoch === locator.epoch) return { ok: true, value: current.head }
    const currentDigest = canonicalJsonDigest(JSON.parse(JSON.stringify(current.head)) as JsonValue)
    if (currentDigest !== digest) return { ok: false, error: refusal('conflict', 'locator_uncertain') }
    const next = retargetLocator(current.head, locator.epoch)
    const written = writeGeneration(
      directory,
      current.id,
      { id: `adopt-${String(locator.epoch)}`, head: next, fingerprint: null, result: null },
      onPhase,
    )
    if (!written.ok) return written
    return { ok: true, value: next }
  })
}

function moveJournal(
  value: JsonValue | null,
): { toEndpoint: string; toEpoch: number; headDigest: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as { toEndpoint?: unknown; toEpoch?: unknown; headDigest?: unknown }
  if (
    typeof body.toEndpoint !== 'string' ||
    typeof body.toEpoch !== 'number' ||
    typeof body.headDigest !== 'string'
  )
    return null
  return { toEndpoint: body.toEndpoint, toEpoch: body.toEpoch, headDigest: body.headDigest }
}

function receipt(
  upgradeId: string,
  state: MigrationReceipt['state'],
  checkpointRevision: number,
  cutoverId: string | null,
): MigrationReceipt {
  return { upgradeId, state, checkpointRevision, cutoverId, commitRef: cutoverId, diagnosticIds: [] }
}

function loadHead(
  directory: string,
  authority: StateAuthorityRef,
  locator: BootstrapLocator,
): Outcome<DirectoryHead> {
  let current: string | null
  try {
    current = readPointer(directory)
  } catch {
    return { ok: false, error: refusal('incompatible', 'directory_corrupt') }
  }
  if (current === null) return { ok: true, value: emptyHead(authority, locator.epoch) }
  const document = readGeneration(directory, current)
  if (!document?.head) return { ok: false, error: refusal('incompatible', 'directory_corrupt') }
  if (
    document.head.authority.authorityId !== authority.authorityId ||
    document.head.authority.tenantId !== authority.tenantId
  ) {
    return { ok: false, error: refusal('conflict', 'directory_authority') }
  }
  return { ok: true, value: document.head }
}

function mutate<T>(
  directory: string,
  fallback: DirectoryHead,
  body: (current: HeldGeneration) => Outcome<T>,
): Outcome<T> {
  try {
    return mutateStore(directory, fallback, body)
  } catch (error) {
    if (error instanceof PhaseStop) throw error
    return { ok: false, error: refusal('retryable', 'directory_unavailable') }
  }
}

function mutateStore<T>(
  directory: string,
  fallback: DirectoryHead,
  body: (current: HeldGeneration) => Outcome<T>,
): Outcome<T> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'lock.db'))
  try {
    db.exec('PRAGMA busy_timeout=5000')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch {
      return { ok: false, error: refusal('conflict', 'directory_busy') }
    }
    try {
      reclaimTemps(directory)
      let id: string | null
      try {
        id = readPointer(directory)
      } catch {
        return { ok: false, error: refusal('incompatible', 'directory_corrupt') }
      }
      if (id === null) return body({ id: null, head: fallback })
      const document = readGeneration(directory, id)
      if (!document?.head) return { ok: false, error: refusal('incompatible', 'directory_corrupt') }
      return body({ id, head: document.head })
    } finally {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* The exclusive lock releases when the handle closes. */
      }
    }
  } finally {
    db.close()
  }
}

function writeGeneration(
  directory: string,
  previousId: string | null,
  document: GenerationDocument,
  onPhase: AuthorityDirectoryOpenOptions['onPhase'],
): Outcome<true> {
  const folder = join(directory, 'generations')
  ensurePrivateDir(folder)
  const name = fileName(document.id)
  const staging = join(directory, 'staging')
  ensurePrivateDir(staging)
  const temp = join(staging, `.${name}.${randomUUID()}.tmp`)
  const finalPath = join(folder, name)
  let descriptor: number | undefined
  try {
    descriptor = createPrivateFileSync(temp)
    writeFileSync(descriptor, JSON.stringify(document))
    fire(onPhase, 'temp')
    fsyncSync(descriptor)
    fire(onPhase, 'fsync')
  } catch (error) {
    if (error instanceof PhaseStop && (error.phase === 'commit' || error.phase === 'notify')) throw error
    return { ok: false, error: refusal('retryable', 'durability_failed') }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  try {
    replaceAuthorityFileSync(temp, finalPath)
    fire(onPhase, 'rename')
    publishOrigins(directory, document)
    if (previousId !== null) seal(directory, previousId)
    const pointerTemp = join(staging, `.current.${randomUUID()}.tmp`)
    const pointerFd = createPrivateFileSync(pointerTemp)
    try {
      writeFileSync(pointerFd, document.id)
      fsyncSync(pointerFd)
    } finally {
      closeSync(pointerFd)
    }
    replaceAuthorityFileSync(pointerTemp, join(directory, 'current'))
    fire(onPhase, 'commit')
  } catch {
    if (pointerShows(directory, document.id)) throw new PhaseStop('commit')
    return { ok: false, error: refusal('retryable', 'durability_failed') }
  }
  return { ok: true, value: true }
}

function seal(directory: string, id: string): void {
  const folder = join(directory, 'seals')
  ensurePrivateDir(folder)
  const finalPath = join(folder, fileName(id))
  if (existsSync(finalPath)) return
  const temp = join(directory, 'staging', `.${fileName(id)}.${randomUUID()}.tmp`)
  const descriptor = createPrivateFileSync(temp)
  try {
    writeFileSync(descriptor, id)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  replaceAuthorityFileSync(temp, finalPath)
}

function readApproval(
  directory: string,
  upgradeId: string,
): { validationDigest: string; authorityIds: readonly string[] } | null {
  const id = `approval:${canonicalJsonDigest(upgradeId)}`
  if (!isCommitted(directory, id)) return null
  const approval = readGeneration(directory, id)?.approval
  return approval
    ? {
        validationDigest: canonicalJsonDigest(
          JSON.parse(JSON.stringify(approval.validationRef)) as JsonValue,
        ),
        authorityIds: approval.authorityIds,
      }
    : null
}

function originName(domainId: string, digest: string): string {
  return canonicalJsonDigest({ domainId, digest })
}

function hasOrigin(directory: string, domainId: string, digest: string): boolean {
  try {
    const id = readFileSync(join(directory, 'origins', originName(domainId, digest)), 'utf8')
    if (!isCommitted(directory, id)) return false
    return (
      readGeneration(directory, id)?.origins?.some(
        (origin) => origin.domainId === domainId && origin.digest === digest,
      ) === true
    )
  } catch {
    return false
  }
}

function publishOrigins(directory: string, document: GenerationDocument): void {
  if (!document.origins?.length) return
  const folder = join(directory, 'origins')
  ensurePrivateDir(folder)
  for (const origin of document.origins) {
    if (hasOrigin(directory, origin.domainId, origin.digest)) continue
    const name = originName(origin.domainId, origin.digest)
    const temp = join(directory, 'staging', `.${name}.${randomUUID()}.tmp`)
    const fd = createPrivateFileSync(temp)
    try {
      writeFileSync(fd, document.id)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    replaceAuthorityFileSync(temp, join(folder, name))
  }
}

function readCommitted(
  directory: string,
  id: string,
): { readonly fingerprint: string; readonly result: AuthorityDirectoryCompareAndSwapResult } | null {
  const key = `publication:${id}`
  if (!isCommitted(directory, key)) return null
  const document = readGeneration(directory, key)
  if (!document?.fingerprint || !document.result) return null
  return { fingerprint: document.fingerprint, result: document.result }
}

function isCommitted(directory: string, id: string): boolean {
  if (pointerShows(directory, id)) return true
  return existsSync(join(directory, 'seals', fileName(id)))
}

function pointerShows(directory: string, id: string): boolean {
  try {
    return readPointer(directory) === id
  } catch {
    return false
  }
}

function readPointer(directory: string): string | null {
  try {
    const text = readFileSync(join(directory, 'current'), 'utf8').trim()
    if (text.length === 0) throw new Error('empty directory pointer')
    return text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function readGeneration(directory: string, id: string): GenerationDocument | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(directory, 'generations', fileName(id)), 'utf8'),
    ) as GenerationDocument
    if (!parsed || typeof parsed !== 'object' || !validHead(parsed.head)) return null
    return parsed
  } catch {
    return null
  }
}

function validHead(head: DirectoryHead): boolean {
  if (
    !head ||
    !validateRuntime('StateAuthorityRef', head.authority).ok ||
    ![head.writerEpoch, head.directoryEpoch, head.locatorEpoch].every(
      (value) => validateRuntime('UInt53', value).ok && value >= 1,
    ) ||
    typeof head.fenced !== 'boolean' ||
    (head.migrationId !== null && typeof head.migrationId !== 'string') ||
    !head.routes ||
    !head.domains ||
    !Array.isArray(head.activations)
  )
    return false
  for (const value of Object.values(head.routes))
    if (
      !value ||
      !validateRuntime('UInt53', value.revision).ok ||
      !validateRuntime('AuthorityRoute', value.route).ok
    )
      return false
  for (const value of Object.values(head.domains))
    if (
      !value ||
      !validateRuntime('UInt53', value.revision).ok ||
      !validateRuntime('JointDispatchMigrationMapping', value.current).ok
    )
      return false
  return head.activations.every(
    (value) =>
      value &&
      validateRuntime('Id', value.logicalAuthorityId).ok &&
      validateRuntime('UInt53', value.authorityEpoch).ok &&
      validateRuntime('Id', value.cutoverId).ok,
  )
}

function copyStore(from: string, to: string): void {
  let existingAncestor = dirname(to)
  while (!existsSync(existingAncestor)) existingAncestor = dirname(existingAncestor)
  mkdirSync(resolve(to, '..'), { recursive: true, mode: 0o700 })
  mkdirSync(to, { mode: 0o700 })
  for (const name of ['current', 'generations', 'seals', 'origins']) {
    const source = join(from, name)
    if (existsSync(source)) copyTree(source, join(to, name))
  }
  for (let folder = to; ; folder = dirname(folder)) {
    syncAuthorityDirectorySync(folder)
    if (folder === existingAncestor) break
  }
}

function copyTree(from: string, to: string): void {
  const kind = lstatSync(from)
  if (kind.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL)
    syncFileSync(to)
    return
  }
  if (!kind.isDirectory()) throw new Error('Directory candidate contains a non-regular entry')
  mkdirSync(to, { mode: 0o700 })
  const folder = opendirSync(from)
  try {
    for (let entry = folder.readSync(); entry !== null; entry = folder.readSync())
      copyTree(join(from, entry.name), join(to, entry.name))
  } finally {
    folder.closeSync()
  }
  syncAuthorityDirectorySync(to)
}

function ensurePrivateDir(folder: string): void {
  if (existsSync(folder)) return
  createPrivateDirectorySync(folder)
}

function reclaimTemps(directory: string): void {
  for (const folder of [join(directory, 'staging')]) {
    if (!existsSync(folder)) continue
    for (const name of readdirSync(folder)) {
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue
      try {
        unlinkSync(join(folder, name))
      } catch {
        /* The next lock holder removes a crashed temporary file. */
      }
    }
  }
}

function fileName(id: string): string {
  return canonicalJsonDigest(id)
}

function fire(onPhase: AuthorityDirectoryOpenOptions['onPhase'], phase: DurabilityPhase): void {
  try {
    onPhase?.(phase)
  } catch (error) {
    if (error instanceof PhaseStop) throw error
    throw new PhaseStop(phase)
  }
}

function isHead(value: DirectoryHead | PublicationRefusal): value is DirectoryHead {
  return !('detailCode' in value)
}

function refusal(code: PublicationRefusal['code'], detailCode: string): RuntimeError {
  return {
    code,
    detailCode,
    message: 'Authority directory refused the request',
    retryAdvice: { kind: code === 'retryable' ? 'retry_same_action' : 'never' },
    diagnosticId: 'authority-directory',
  }
}

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, statfsSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AuthorityDirectoryCompareAndSwapRequest,
  AuthorityDirectoryCompareAndSwapResult,
  AuthorityDirectoryReadRequest,
  AuthorityDirectoryReadResult,
  AuthorityPublication,
  AuthorityRoute,
  DataRef,
  JointDispatchMigrationMapping,
  JsonValue,
  MigrationReceipt,
  MigrationRequest,
  StateAuthorityRef,
} from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export const REFERENCE_AUTHORITY_CONTRACT = 'agh.authority-directory' as const
export const REFERENCE_AUTHORITY_DIRECTORY_ID = 'agh.reference/authority-directory' as const

export interface ReferenceLocator {
  readonly directoryId: string
  readonly providerLockRef: DataRef
  readonly endpointRef: string
  readonly epoch: number
  readonly revision: number
  readonly cutoverId: string
}

export interface ReferenceAnchor {
  read(): Outcome<{ readonly locator: ReferenceLocator; readonly credential: ReferenceCredential }>
  compareAndSwap(expectedRevision: number, next: ReferenceLocator): Outcome<ReferenceLocator>
  writeJournal(id: string, body: JsonValue): Outcome<{ readonly id: string }>
  readJournal(id: string): Outcome<JsonValue | null>
}

interface ReferenceCredential {
  readonly principalRef: string
  readonly directoryId: string
  readonly credentialDigest: string
}

interface RouteHead {
  writerEpoch: number
  directoryEpoch: number
  locatorEpoch: number
  moveOwner: string | null
  fenced: boolean
  authority: StateAuthorityRef
  routes: Record<string, { revision: number; route: AuthorityRoute }>
  domains: Record<string, { revision: number; latest: JointDispatchMigrationMapping }>
  activations: { logicalAuthorityId: string; authorityEpoch: number; cutoverId: string }[]
}

interface CutoverRow {
  readonly fingerprint: string
  readonly result: AuthorityDirectoryCompareAndSwapResult
}

type Stop = {
  readonly code: Extract<Outcome<unknown>, { ok: false }>['error']['code']
  readonly detail: string
}
type Verdict =
  | { readonly tag: 'replay'; readonly result: AuthorityDirectoryCompareAndSwapResult }
  | { readonly tag: 'stop'; readonly stop: Stop }
  | {
      readonly tag: 'store'
      readonly head: RouteHead
      readonly result: AuthorityDirectoryCompareAndSwapResult
      readonly fingerprint: string
    }

export interface ReferenceDirectory {
  readonly providerId: typeof REFERENCE_AUTHORITY_DIRECTORY_ID
  readonly contract: typeof REFERENCE_AUTHORITY_CONTRACT
  readonly features: readonly string[]
  readonly unsupported: readonly string[]
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
    input: {
      readonly upgradeId: string
      readonly validationRef: DataRef
      readonly authorityIds: readonly string[]
    },
    context: CallContext,
  ): Promise<Outcome<{ readonly upgradeId: string }>>
  recordActivation(
    input: {
      readonly logicalAuthorityId: string
      readonly authorityEpoch: number
      readonly cutoverId: string
    },
    context: CallContext,
  ): Promise<Outcome<{ readonly recorded: true }>>
  freeze(context: CallContext): Promise<Outcome<{ readonly fenced: true }>>
  releaseFreeze(context: CallContext): Promise<Outcome<{ readonly fenced: false }>>
  probeCutover(
    cutoverId: string,
    context: CallContext,
  ): Promise<Outcome<AuthorityDirectoryCompareAndSwapResult | { readonly state: 'absent' }>>
  dispose(): Promise<void>
}

const UNSUPPORTED = [
  'local-fs-rename',
  'temp',
  'fsync',
  'rename',
  'run-state-transfer',
  'auto-compatible-transfer',
] as const

export function createReferenceAuthorityDirectory(options: {
  readonly directory: string
  readonly anchor: string
  readonly authority: StateAuthorityRef
  readonly filesystem?: 'local' | 'unsupported'
  readonly onPhase?: (phase: 'transaction' | 'commit' | 'notify') => void
}): ReferenceDirectory {
  const directory = resolve(options.directory)
  const anchor = resolve(options.anchor)
  const store = resolve(directory, 'routes.sqlite')
  let disposed = false
  const blocked = options.filesystem === 'unsupported' || !localSqliteLocation(directory)

  function admit(
    context: CallContext,
    request: unknown,
    schema: Parameters<typeof validateRuntime>[0] | null,
  ) {
    if (disposed) return halt('denied', 'directory_disposed')
    if (!separated(directory, anchor)) return halt('incompatible', 'anchor_nested')
    if (blocked) return halt('incompatible', 'filesystem_unsupported')
    if (context.signal.aborted) return halt('cancelled', 'directory_cancelled')
    if (schema !== null && !validateRuntime(schema, request).ok) return halt('invalid_input', 'schema')
    return loadAnchor(anchor, context.principalRef)
  }

  function blank(epoch: number): RouteHead {
    return {
      writerEpoch: 1,
      directoryEpoch: options.authority.authorityEpoch,
      locatorEpoch: epoch,
      fenced: false,
      moveOwner: null,
      authority: options.authority,
      routes: {},
      domains: {},
      activations: [],
    }
  }

  function ready(view: { locator: ReferenceLocator }): Outcome<RouteHead> {
    if (view.locator.endpointRef !== directory) return halt('conflict', 'locator_uncertain')
    const loaded = readHead(store, blank(view.locator.epoch))
    if (!loaded.ok) return loaded
    if (!sameContainer(loaded.value.authority, options.authority))
      return halt('conflict', 'directory_authority')
    if (loaded.value.locatorEpoch === view.locator.epoch) return loaded
    return adopt(store, anchor, loaded.value, view.locator, options.onPhase)
  }

  function edit(
    view: { locator: ReferenceLocator; credential: ReferenceCredential },
    change: (head: RouteHead) => RouteHead | { stop: Stop },
    allowFrozen = false,
  ): Outcome<true> {
    return immediate(store, (db) => {
      const live = loadAnchor(anchor, view.credential.principalRef)
      if (!live.ok) return live
      if (
        live.value.locator.epoch !== view.locator.epoch ||
        live.value.locator.revision !== view.locator.revision ||
        live.value.locator.endpointRef !== directory
      )
        return halt('conflict', 'locator_uncertain')
      const current = takeHead(db, blank(view.locator.epoch))
      if (!current.ok) return current
      if (current.value.locatorEpoch !== view.locator.epoch) return halt('conflict', 'locator_uncertain')
      if (!allowFrozen && current.value.fenced) return halt('conflict', 'directory_fenced')
      const next = change(current.value)
      if ('stop' in next) return halt(next.stop.code, next.stop.detail)
      putHead(db, next)
      return { ok: true, value: true }
    })
  }

  function afterWrite<T>(wrote: boolean, value: T, notify: boolean): Outcome<T> {
    if (!wrote) return { ok: true, value }
    options.onPhase?.('commit')
    if (notify) options.onPhase?.('notify')
    return { ok: true, value }
  }

  return {
    providerId: REFERENCE_AUTHORITY_DIRECTORY_ID,
    contract: REFERENCE_AUTHORITY_CONTRACT,
    features: ['cutover-replay', 'external-anchor', 'sqlite-immediate'],
    unsupported: UNSUPPORTED,
    async read(request, context) {
      const gated = admit(context, request, 'AuthorityDirectoryReadRequest')
      if (!gated.ok) return gated
      const head = ready(gated.value)
      if (!head.ok) return head
      return immediate(store, (db) => {
        const live = admit(context, null, null)
        if (!live.ok) return live
        if (
          live.value.locator.epoch !== gated.value.locator.epoch ||
          live.value.locator.revision !== gated.value.locator.revision ||
          live.value.locator.endpointRef !== directory
        )
          return halt('conflict', 'locator_uncertain')
        const current = takeHead(db, blank(gated.value.locator.epoch))
        if (!current.ok) return current
        const answer = answerRead(
          current.value,
          request,
          (domain, fingerprint) =>
            db
              .prepare('SELECT 1 FROM domain_origin WHERE domain_id = ? AND qualification_digest = ?')
              .get(domain, fingerprint) !== undefined,
        )
        if ('stop' in answer) return halt(answer.stop.code, answer.stop.detail)
        return { ok: true as const, value: answer.value }
      })
    },
    async compareAndSwap(request, context) {
      const gated = admit(context, request, 'AuthorityDirectoryCompareAndSwapRequest')
      if (!gated.ok) return gated
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      let wrote = false
      const outcome = immediate(store, (db) => {
        const live = admit(context, null, null)
        if (!live.ok) return live
        if (
          live.value.locator.epoch !== gated.value.locator.epoch ||
          live.value.locator.revision !== gated.value.locator.revision ||
          live.value.locator.endpointRef !== directory
        )
          return halt('conflict', 'locator_uncertain')
        const current = takeHead(db, blank(gated.value.locator.epoch))
        if (!current.ok) return current
        if (
          gated.value.locator.endpointRef !== directory ||
          current.value.locatorEpoch !== gated.value.locator.epoch
        ) {
          return halt('conflict', 'locator_uncertain')
        }
        const verdict = judge(
          current.value,
          request,
          takeCutover(db, request.publication.cutoverId),
          takeApproval(db, request.publication.upgradeId),
        )
        if (verdict.tag === 'stop') return halt(verdict.stop.code, verdict.stop.detail)
        if (verdict.tag === 'replay') return { ok: true as const, value: verdict.result }
        putHead(db, verdict.head)
        const insertOrigin = db.prepare(
          'INSERT OR IGNORE INTO domain_origin(domain_id, qualification_digest) VALUES (?, ?)',
        )
        for (const link of request.publication.jointDispatchMappings) {
          for (const value of [link.from, link.to])
            insertOrigin.run(
              link.domainId,
              canonicalJsonDigest(JSON.parse(JSON.stringify(value)) as JsonValue),
            )
        }
        putCutover(db, request.publication.cutoverId, verdict.fingerprint, verdict.result)
        options.onPhase?.('transaction')
        wrote = true
        return { ok: true as const, value: verdict.result }
      })
      if (!outcome.ok) return outcome
      return afterWrite(wrote, outcome.value, true)
    },
    async transfer(request, context) {
      const gated = admit(context, request, 'MigrationRequest')
      if (!gated.ok) return gated
      if (request.target.kind !== 'directory') return halt('incompatible', 'transfer_kind_unsupported')
      if (request.mode === 'auto-compatible') return halt('incompatible', 'transfer_mode_unsupported')
      if (request.mode === 'inspect-only') {
        const head = ready(gated.value)
        const blockedMove = !head.ok || head.value.fenced
        return {
          ok: true,
          value: movedReceipt(
            request.upgradeId,
            blockedMove ? 'blocked' : 'planned',
            gated.value.locator.revision,
            null,
          ),
        }
      }
      const head = ready(gated.value)
      if (!head.ok) return head
      return relocate(
        directory,
        anchor,
        store,
        options.authority,
        gated.value.locator,
        request,
        context.principalRef,
        options.onPhase,
      )
    },
    async seedRoute(route, context) {
      const gated = admit(context, route, 'AuthorityRoute')
      if (!gated.ok) return gated
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      const wrote = edit(gated.value, (head) => plant(head, route))
      if (!wrote.ok) return wrote
      return afterWrite(true, { revision: 1 }, false)
    },
    async approveUpgrade(input, context) {
      const gated = admit(context, input.validationRef, 'DataRef')
      if (!gated.ok) return gated
      if (!validateRuntime('Id', input.upgradeId).ok) return halt('invalid_input', 'schema')
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      const wrote = immediate(store, (db) => {
        const live = admit(context, null, null)
        if (!live.ok) return live
        if (
          live.value.locator.epoch !== gated.value.locator.epoch ||
          live.value.locator.revision !== gated.value.locator.revision ||
          live.value.locator.endpointRef !== directory
        )
          return halt('conflict', 'locator_uncertain')
        const current = takeHead(db, blank(gated.value.locator.epoch))
        if (!current.ok) return current
        if (current.value.locatorEpoch !== gated.value.locator.epoch)
          return halt('conflict', 'locator_uncertain')
        if (current.value.fenced) return halt('conflict', 'directory_fenced')
        if (takeApproval(db, input.upgradeId)) return halt('conflict', 'upgrade_exists')
        if (
          input.authorityIds.length === 0 ||
          new Set(input.authorityIds).size !== input.authorityIds.length
        ) {
          return halt('invalid_input', 'journal_authorities')
        }
        db.prepare('INSERT INTO route_approval(upgrade_key, payload) VALUES (?, ?)').run(
          input.upgradeId,
          JSON.stringify({
            validationDigest: canonicalJsonDigest(
              JSON.parse(JSON.stringify(input.validationRef)) as JsonValue,
            ),
            authorityIds: input.authorityIds,
          }),
        )
        return { ok: true as const, value: true }
      })
      if (!wrote.ok) return wrote
      return afterWrite(true, { upgradeId: input.upgradeId }, false)
    },
    async recordActivation(input, context) {
      const gated = admit(context, null, null)
      if (!gated.ok) return gated
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      const wrote = edit(gated.value, (head) => noteActivation(head, input))
      if (!wrote.ok) return wrote
      return afterWrite(true, { recorded: true as const }, false)
    },
    async freeze(context) {
      const gated = admit(context, null, null)
      if (!gated.ok) return gated
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      if (opened.value.fenced) return { ok: true, value: { fenced: true } }
      const wrote = edit(gated.value, (head) => ({ ...head, fenced: true }), true)
      if (!wrote.ok) return wrote
      return afterWrite(true, { fenced: true as const }, false)
    },
    async releaseFreeze(context) {
      const gated = admit(context, null, null)
      if (!gated.ok) return gated
      if (gated.value.locator.endpointRef !== directory) return halt('conflict', 'locator_uncertain')
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      if (!opened.value.fenced) return { ok: true, value: { fenced: false } }
      const wrote = edit(
        gated.value,
        (head) =>
          head.moveOwner !== null
            ? { stop: { code: 'conflict', detail: 'directory_fenced' } }
            : { ...head, fenced: false },
        true,
      )
      if (!wrote.ok) return wrote
      return afterWrite(true, { fenced: false as const }, false)
    },
    async probeCutover(cutoverId, context) {
      const gated = admit(context, cutoverId, 'Id')
      if (!gated.ok) return gated
      const opened = ready(gated.value)
      if (!opened.ok) return opened
      const found = readCutover(store, cutoverId)
      if (!found) return { ok: true, value: { state: 'absent' as const } }
      return { ok: true, value: found.result }
    },
    async dispose() {
      disposed = true
    },
  }
}

export function createReferenceAnchor(
  anchor: string,
  locator: ReferenceLocator,
  principalRef: string,
): Outcome<ReferenceAnchor> {
  const checked = checkLocator(locator)
  if (!checked.ok) return checked
  const file = anchorFile(anchor)
  mkdirSync(anchor, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA synchronous=FULL')
    ensureAnchor(db)
    const existing = db.prepare('SELECT payload FROM anchor_view WHERE slot = 1').get()
    if (existing) return halt('incompatible', 'anchor_unwritable')
    const view = { locator: checked.value, credential: credential(principalRef, checked.value.directoryId) }
    db.prepare('INSERT INTO anchor_view(slot, payload) VALUES (1, ?)').run(JSON.stringify(view))
  } finally {
    db.close()
  }
  return openReferenceAnchor(anchor)
}

export function openReferenceAnchor(anchor: string): Outcome<ReferenceAnchor> {
  const current = readReferenceAnchor(anchor)
  if (!current.ok) return current
  if (!current.value) return halt('incompatible', 'anchor_absent')
  return { ok: true, value: anchorApi(anchor) }
}

export function readReferenceAnchor(
  anchor: string,
): Outcome<{ readonly locator: ReferenceLocator; readonly credential: ReferenceCredential } | null> {
  const file = anchorFile(anchor)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    if (missingFile(error)) return { ok: true, value: null }
    return halt('incompatible', 'anchor_unreadable')
  }
  try {
    const row = db.prepare('SELECT payload FROM anchor_view WHERE slot = 1').get() as
      | { payload: string }
      | undefined
    if (!row) return { ok: true, value: null }
    return parseAnchor(row.payload)
  } catch {
    return halt('incompatible', 'anchor_corrupt')
  } finally {
    db.close()
  }
}

function anchorApi(anchor: string): ReferenceAnchor {
  const file = anchorFile(anchor)
  return {
    read() {
      const opened = readReferenceAnchor(anchor)
      if (!opened.ok) return opened
      if (!opened.value) return halt('incompatible', 'anchor_absent')
      return { ok: true, value: opened.value }
    },
    compareAndSwap(expectedRevision, next) {
      const checked = checkLocator(next)
      if (!checked.ok) return checked
      return immediateAnchor(file, (db) => {
        const row = db.prepare('SELECT payload FROM anchor_view WHERE slot = 1').get() as
          | { payload: string }
          | undefined
        if (!row) return halt('incompatible', 'anchor_absent')
        const parsed = parseAnchor(row.payload)
        if (!parsed.ok || !parsed.value) return parsed.ok ? halt('incompatible', 'anchor_absent') : parsed
        if (parsed.value.locator.revision !== expectedRevision) return halt('conflict', 'locator_revision')
        if (checked.value.revision !== expectedRevision + 1) return halt('invalid_input', 'locator_revision')
        if (checked.value.epoch !== parsed.value.locator.epoch + 1)
          return halt('invalid_input', 'epoch_not_increasing')
        if (checked.value.directoryId !== parsed.value.locator.directoryId)
          return halt('invalid_input', 'route_identity')
        const view = { locator: checked.value, credential: parsed.value.credential }
        db.prepare('UPDATE anchor_view SET payload = ? WHERE slot = 1').run(JSON.stringify(view))
        return { ok: true as const, value: checked.value }
      })
    },
    writeJournal(id, body) {
      if (!validateRuntime('Id', id).ok) return halt('invalid_input', 'schema')
      return immediateAnchor(file, (db) => {
        db.prepare(
          'INSERT INTO anchor_note(note_key, payload) VALUES (?, ?) ON CONFLICT(note_key) DO UPDATE SET payload = excluded.payload',
        ).run(id, JSON.stringify(body))
        return { ok: true as const, value: { id } }
      })
    },
    readJournal(id) {
      if (!validateRuntime('Id', id).ok) return halt('invalid_input', 'schema')
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        const row = db.prepare('SELECT payload FROM anchor_note WHERE note_key = ?').get(id) as
          | { payload: string }
          | undefined
        return { ok: true, value: row ? (JSON.parse(row.payload) as JsonValue) : null }
      } finally {
        db.close()
      }
    },
  }
}

function relocate(
  directory: string,
  anchor: string,
  store: string,
  authority: StateAuthorityRef,
  locator: ReferenceLocator,
  migration: MigrationRequest,
  principalRef: string,
  onPhase: ((phase: 'transaction' | 'commit' | 'notify') => void) | undefined,
): Outcome<MigrationReceipt> {
  if (migration.target.kind !== 'directory') return halt('incompatible', 'transfer_kind_unsupported')
  const target = migration.target
  if (locator.revision !== target.sourceLocatorRevision) return halt('conflict', 'locator_revision')
  if (locator.endpointRef !== directory) return halt('conflict', 'locator_uncertain')
  const standby = resolve(directory, '..', 'standby', target.targetLocationRef)
  if (!separated(directory, standby) || !separated(directory, anchor) || !separated(standby, anchor)) {
    return halt('incompatible', 'anchor_nested')
  }
  const frozen = immediate(store, (db) => {
    const current = takeHead(db, emptyOwned(authority, locator.epoch))
    if (!current.ok) return current
    const live = loadAnchor(anchor, principalRef)
    if (!live.ok) return live
    if (live.value.locator.epoch !== locator.epoch || live.value.locator.endpointRef !== directory)
      return halt('conflict', 'locator_uncertain')
    if (current.value.moveOwner !== null && current.value.moveOwner !== migration.upgradeId)
      return halt('conflict', 'directory_fenced')
    if (current.value.moveOwner === migration.upgradeId) return { ok: true as const, value: current.value }
    const next = { ...current.value, fenced: true, moveOwner: migration.upgradeId }
    putHead(db, next)
    return { ok: true as const, value: next }
  })
  if (!frozen.ok) return frozen
  onPhase?.('commit')
  const digest = canonicalJsonDigest(JSON.parse(JSON.stringify(frozen.value)) as JsonValue)
  if (existsSync(standby)) return halt('incompatible', 'target_exists')
  try {
    mkdirSync(dirname(standby), { recursive: true, mode: 0o700 })
    mkdirSync(standby, { mode: 0o700 })
    cloneRows(store, resolve(standby, 'routes.sqlite'))
    for (const path of [
      resolve(standby, 'routes.sqlite'),
      standby,
      dirname(standby),
      dirname(dirname(standby)),
    ]) {
      const descriptor = openSync(path, 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    }
  } catch {
    return halt('retryable', 'durability_failed')
  }
  const handle = openReferenceAnchor(anchor)
  if (!handle.ok) return handle
  const body = {
    upgradeId: migration.upgradeId,
    journalRef: target.externalJournalRef,
    fromEndpoint: directory,
    toEndpoint: standby,
    fromEpoch: locator.epoch,
    toEpoch: locator.epoch + 1,
    headDigest: digest,
  }
  const journal = handle.value.writeJournal(migration.upgradeId, body)
  if (!journal.ok) return journal
  if (target.externalJournalRef !== migration.upgradeId) {
    const alias = handle.value.writeJournal(target.externalJournalRef, body)
    if (!alias.ok) return alias
  }
  const nextLocator: ReferenceLocator = {
    directoryId: locator.directoryId,
    providerLockRef: target.targetProviderLock,
    endpointRef: standby,
    epoch: locator.epoch + 1,
    revision: locator.revision + 1,
    cutoverId: migration.upgradeId,
  }
  const swapped = handle.value.compareAndSwap(locator.revision, nextLocator)
  if (!swapped.ok) return swapped
  const adopted = adopt(resolve(standby, 'routes.sqlite'), anchor, frozen.value, nextLocator, onPhase)
  if (!adopted.ok) return adopted
  return {
    ok: true,
    value: movedReceipt(migration.upgradeId, 'committed', nextLocator.revision, migration.upgradeId),
  }
}

function adopt(
  store: string,
  anchor: string,
  head: RouteHead,
  locator: ReferenceLocator,
  onPhase: ((phase: 'transaction' | 'commit' | 'notify') => void) | undefined,
): Outcome<RouteHead> {
  const opened = openReferenceAnchor(anchor)
  if (!opened.ok) return opened
  const journal = opened.value.readJournal(locator.cutoverId)
  if (!journal.ok) return journal
  const digest = canonicalJsonDigest(JSON.parse(JSON.stringify(head)) as JsonValue)
  const recorded = journalBody(journal.value)
  if (
    !recorded ||
    recorded.toEndpoint !== locator.endpointRef ||
    recorded.toEpoch !== locator.epoch ||
    recorded.headDigest !== digest
  ) {
    return halt('conflict', 'locator_uncertain')
  }
  const outcome = immediate(store, (db) => {
    const current = takeHead(db, head)
    if (!current.ok) return current
    if (current.value.locatorEpoch === locator.epoch) return { ok: true as const, value: current.value }
    const currentDigest = canonicalJsonDigest(JSON.parse(JSON.stringify(current.value)) as JsonValue)
    if (currentDigest !== digest) return halt('conflict', 'locator_uncertain')
    const next = {
      ...current.value,
      locatorEpoch: locator.epoch,
      directoryEpoch: locator.epoch,
      fenced: false,
      moveOwner: null,
    }
    putHead(db, next)
    return { ok: true as const, value: next }
  })
  if (!outcome.ok) return outcome
  onPhase?.('commit')
  return outcome
}

function judge(
  head: RouteHead,
  request: AuthorityDirectoryCompareAndSwapRequest,
  existing: CutoverRow | null,
  journal: { validationDigest: string; authorityIds: readonly string[] } | null,
): Verdict {
  if (request.transactionId !== request.publication.cutoverId)
    return { tag: 'stop', stop: { code: 'invalid_input', detail: 'cutover_transaction_mismatch' } }
  const fingerprint = canonicalJsonDigest(JSON.parse(JSON.stringify(request)) as JsonValue)
  if (existing && existing.fingerprint !== fingerprint)
    return { tag: 'stop', stop: { code: 'conflict', detail: 'cutover_identity_conflict' } }
  if (existing) return { tag: 'replay', result: existing.result }
  if (head.fenced) return { tag: 'stop', stop: { code: 'conflict', detail: 'directory_fenced' } }
  if (!sameContainer(head.authority, request.authority))
    return { tag: 'stop', stop: { code: 'conflict', detail: 'directory_authority' } }
  if (request.expectedWriterEpoch !== head.writerEpoch)
    return { tag: 'stop', stop: { code: 'conflict', detail: 'writer_epoch' } }
  if (!journal) return { tag: 'stop', stop: { code: 'incompatible', detail: 'upgrade_not_journaled' } }
  if (
    journal.validationDigest !==
    canonicalJsonDigest(JSON.parse(JSON.stringify(request.publication.validationRef)) as JsonValue)
  )
    return { tag: 'stop', stop: { code: 'incompatible', detail: 'validation_mismatch' } }
  const shaped = shapePublication(head, request.publication, journal.authorityIds)
  if ('stop' in shaped) return { tag: 'stop', stop: shaped.stop }
  const revisions = matchRevisions(head, shaped.changes)
  if ('stop' in revisions) return { tag: 'stop', stop: revisions.stop }
  const result = {
    transactionId: request.transactionId,
    cutoverId: request.publication.cutoverId,
    routes: shaped.changes
      .map((change) => ({
        logicalAuthorityId: change.next.logicalAuthorityId,
        revision: revisions.values.get(change.next.logicalAuthorityId) ?? 0,
        authorityEpoch: change.next.authorityEpoch,
      }))
      .sort((left, right) => orderId(left.logicalAuthorityId, right.logicalAuthorityId)),
  }
  const routes: RouteHead['routes'] = Object.assign(Object.create(null), head.routes)
  for (const change of shaped.changes) {
    const prior = routes[change.previous.logicalAuthorityId]
    routes[change.previous.logicalAuthorityId] = { revision: (prior?.revision ?? 0) + 1, route: change.next }
  }
  return {
    tag: 'store',
    head: {
      ...head,
      routes,
      domains: shaped.domains,
      activations: head.activations.filter(
        (item) =>
          !shaped.changes.some((change) => change.next.logicalAuthorityId === item.logicalAuthorityId),
      ),
    },
    result,
    fingerprint,
  }
}

function shapePublication(
  head: RouteHead,
  publication: AuthorityPublication,
  members: readonly string[],
): { changes: AuthorityPublication['changes']; domains: RouteHead['domains'] } | { stop: Stop } {
  const seen = new Set<string>()
  for (const change of publication.changes) {
    if (seen.has(change.previous.logicalAuthorityId))
      return { stop: { code: 'invalid_input', detail: 'duplicate_authority' } }
    seen.add(change.previous.logicalAuthorityId)
    const identity = routeLink(change, publication.cutoverId)
    if (identity) return { stop: identity }
    if (!members.includes(change.previous.logicalAuthorityId))
      return { stop: { code: 'incompatible', detail: 'journal_authority' } }
  }
  if (members.length !== seen.size) return { stop: { code: 'incompatible', detail: 'journal_authority' } }
  const fences = fenceKeys(publication)
  if ('stop' in fences) return fences
  for (const change of publication.changes) {
    const key = `${change.previous.logicalAuthorityId}\0${change.previous.tenantId}\0${String(change.previous.authorityEpoch)}`
    if (!fences.keys.has(key)) return { stop: { code: 'incompatible', detail: 'fence_incomplete' } }
  }
  if (fences.keys.size !== seen.size) return { stop: { code: 'incompatible', detail: 'fence_incomplete' } }
  for (const change of publication.changes) {
    const found = publication.sourceFences.find(
      (fence) => fence.source.authorityId === change.previous.logicalAuthorityId,
    )
    if (
      !found ||
      canonicalJsonDigest(JSON.parse(JSON.stringify(found.checkpoint)) as JsonValue) !==
        canonicalJsonDigest(JSON.parse(JSON.stringify(change.previous.checkpoint)) as JsonValue)
    )
      return { stop: { code: 'incompatible', detail: 'fence_checkpoint' } }
  }
  const domains = growDomains(head, publication)
  if ('stop' in domains) return domains
  if (leavesCohort(head, publication, domains.domains))
    return { stop: { code: 'incompatible', detail: 'joint_partial_publication' } }
  return { changes: publication.changes, domains: domains.domains }
}

function routeLink(change: AuthorityPublication['changes'][number], cutoverId: string): Stop | null {
  const previous = change.previous
  const next = change.next
  if (previous.logicalAuthorityId !== next.logicalAuthorityId || previous.tenantId !== next.tenantId)
    return { code: 'invalid_input', detail: 'route_identity' }
  if (next.authorityEpoch <= previous.authorityEpoch)
    return { code: 'invalid_input', detail: 'epoch_not_increasing' }
  if (
    next.previous === null ||
    next.previous.authorityEpoch !== previous.authorityEpoch ||
    next.previous.locationRef !== previous.locationRef ||
    next.previous.cutoverId !== previous.cutoverId
  ) {
    return { code: 'invalid_input', detail: 'previous_link' }
  }
  if (next.cutoverId !== cutoverId) return { code: 'invalid_input', detail: 'cutover_link' }
  if (
    next.checkpoint.authorityId !== next.logicalAuthorityId ||
    next.checkpoint.authorityEpoch !== next.authorityEpoch
  ) {
    return { code: 'invalid_input', detail: 'checkpoint_mismatch' }
  }
  return null
}

function fenceKeys(publication: AuthorityPublication): { keys: Set<string> } | { stop: Stop } {
  const keys = new Set<string>()
  for (const fence of publication.sourceFences) {
    if (fence.upgradeId !== publication.upgradeId)
      return { stop: { code: 'invalid_input', detail: 'fence_upgrade' } }
    if (!fence.writerCredentialsRevoked) return { stop: { code: 'incompatible', detail: 'fence_open' } }
    if (
      fence.checkpoint.authorityId !== fence.source.authorityId ||
      fence.checkpoint.authorityEpoch !== fence.source.authorityEpoch
    ) {
      return { stop: { code: 'invalid_input', detail: 'checkpoint_mismatch' } }
    }
    const key = `${fence.source.authorityId}\0${fence.source.tenantId}\0${String(fence.source.authorityEpoch)}`
    if (keys.has(key)) return { stop: { code: 'invalid_input', detail: 'duplicate_fence' } }
    keys.add(key)
  }
  return { keys }
}

function matchRevisions(
  head: RouteHead,
  changes: AuthorityPublication['changes'],
): { values: Map<string, number> } | { stop: Stop } {
  const values = new Map<string, number>()
  for (const change of changes) {
    const stored = routeEntry(head, change.previous.logicalAuthorityId)
    const sameRoute =
      stored !== undefined &&
      canonicalJsonDigest(JSON.parse(JSON.stringify(stored.route)) as JsonValue) ===
        canonicalJsonDigest(JSON.parse(JSON.stringify(change.previous)) as JsonValue)
    if (!stored || stored.revision !== change.expectedRevision || !sameRoute)
      return { stop: { code: 'conflict', detail: 'revision_mismatch' } }
    if (change.next.cutoverId !== changes[0]?.next.cutoverId)
      return { stop: { code: 'invalid_input', detail: 'cutover_link' } }
    values.set(change.previous.logicalAuthorityId, stored.revision + 1)
  }
  return { values }
}

function growDomains(
  head: RouteHead,
  publication: AuthorityPublication,
): { domains: RouteHead['domains'] } | { stop: Stop } {
  const domains: RouteHead['domains'] = Object.assign(Object.create(null), head.domains)
  const seen = new Set<string>()
  for (const mapping of publication.jointDispatchMappings) {
    if (seen.has(mapping.domainId)) return { stop: { code: 'invalid_input', detail: 'duplicate_authority' } }
    seen.add(mapping.domainId)
    if (mapping.domainId !== mapping.from.domainId || mapping.domainId !== mapping.to.domainId)
      return { stop: { code: 'invalid_input', detail: 'joint_domain' } }
    if (mapping.to.revision <= mapping.from.revision)
      return { stop: { code: 'invalid_input', detail: 'epoch_not_increasing' } }
    const state = publication.changes.find(
      (change) => change.previous.logicalAuthorityId === mapping.to.stateAuthority.authorityId,
    )
    const budget = publication.changes.find(
      (change) => change.previous.logicalAuthorityId === mapping.to.budgetAuthority.authorityId,
    )
    if (!state || !budget) return { stop: { code: 'invalid_input', detail: 'joint_member' } }
    if (!memberAligned(state.next, mapping.to.stateAuthority, mapping.to.stateBinding, mapping.cohortDigest))
      return { stop: { code: 'incompatible', detail: 'joint_binding' } }
    if (
      !memberAligned(budget.next, mapping.to.budgetAuthority, mapping.to.budgetBinding, mapping.cohortDigest)
    )
      return { stop: { code: 'incompatible', detail: 'joint_binding' } }
    if (
      !memberIdentity(state.previous, mapping.from.stateAuthority, mapping.from.stateBinding) ||
      !memberIdentity(budget.previous, mapping.from.budgetAuthority, mapping.from.budgetBinding)
    )
      return { stop: { code: 'incompatible', detail: 'joint_chain_broken' } }
    if (
      canonicalJsonDigest(JSON.parse(JSON.stringify(mapping.validationRef)) as JsonValue) !==
      canonicalJsonDigest(JSON.parse(JSON.stringify(publication.validationRef)) as JsonValue)
    )
      return { stop: { code: 'incompatible', detail: 'validation_mismatch' } }
    const prior = Object.hasOwn(domains, mapping.domainId) ? domains[mapping.domainId] : undefined
    if (prior) {
      const tail = prior.latest
      if (
        !tail ||
        canonicalJsonDigest(JSON.parse(JSON.stringify(tail.to)) as JsonValue) !==
          canonicalJsonDigest(JSON.parse(JSON.stringify(mapping.from)) as JsonValue)
      ) {
        return { stop: { code: 'incompatible', detail: 'joint_chain_broken' } }
      }
    } else if (
      !memberIdentity(state.previous, mapping.from.stateAuthority, mapping.from.stateBinding) ||
      !memberIdentity(budget.previous, mapping.from.budgetAuthority, mapping.from.budgetBinding)
    ) {
      return { stop: { code: 'incompatible', detail: 'joint_chain_broken' } }
    }
    domains[mapping.domainId] = {
      revision: (prior?.revision ?? 0) + 1,
      latest: mapping,
    }
  }
  return { domains }
}

function leavesCohort(
  head: RouteHead,
  publication: AuthorityPublication,
  domains: RouteHead['domains'],
): boolean {
  return publication.changes.some((change) =>
    Object.entries(head.domains).some(([domainId, domain]) => {
      const tail = domain.latest
      if (!tail) return false
      const members = [tail.to.stateAuthority.authorityId, tail.to.budgetAuthority.authorityId]
      return (
        members.includes(change.previous.logicalAuthorityId) &&
        canonicalJsonDigest(JSON.parse(JSON.stringify(domains[domainId])) as JsonValue) ===
          canonicalJsonDigest(JSON.parse(JSON.stringify(domain)) as JsonValue)
      )
    }),
  )
}

function routeEntry(head: RouteHead, key: string) {
  return Object.hasOwn(head.routes, key) ? head.routes[key] : undefined
}

function domainEntry(head: RouteHead, key: string) {
  return Object.hasOwn(head.domains, key) ? head.domains[key] : undefined
}

function answerRead(
  head: RouteHead,
  request: AuthorityDirectoryReadRequest,
  originExists: (domain: string, fingerprint: string) => boolean,
): { value: AuthorityDirectoryReadResult } | { stop: Stop } {
  if (request.kind === 'authority') {
    const stored = routeEntry(head, request.logicalAuthorityId)
    if (!stored) return { stop: { code: 'incompatible', detail: 'route_absent' } }
    return {
      value: {
        kind: 'authority',
        route: stored.route,
        revision: stored.revision,
        epoch: stored.route.authorityEpoch,
      },
    }
  }
  if (request.domainId !== request.from.domainId)
    return { stop: { code: 'invalid_input', detail: 'joint_domain' } }
  const domain = domainEntry(head, request.domainId)
  if (!domain) return { value: { kind: 'joint-dispatch', resolution: { state: 'unmapped' } } }
  const fingerprint = canonicalJsonDigest(JSON.parse(JSON.stringify(request.from)) as JsonValue)
  if (!originExists(request.domainId, fingerprint))
    return { stop: { code: 'incompatible', detail: 'joint_chain_broken' } }
  const current = domain.latest
  const state = routeEntry(head, current.to.stateAuthority.authorityId)
  const budget = routeEntry(head, current.to.budgetAuthority.authorityId)
  if (
    !state ||
    !budget ||
    state.route.authorityEpoch !== current.to.stateAuthority.authorityEpoch ||
    budget.route.authorityEpoch !== current.to.budgetAuthority.authorityEpoch ||
    state.route.tenantId !== current.to.stateAuthority.tenantId ||
    budget.route.tenantId !== current.to.budgetAuthority.tenantId
  ) {
    return { stop: { code: 'incompatible', detail: 'joint_chain_broken' } }
  }
  if (
    !sameBinding(state.route.providerBinding, current.to.stateBinding) ||
    !sameBinding(budget.route.providerBinding, current.to.budgetBinding)
  ) {
    return { stop: { code: 'incompatible', detail: 'joint_binding' } }
  }
  if (!isActive(head, state.route) || !isActive(head, budget.route))
    return { stop: { code: 'incompatible', detail: 'joint_member_inactive' } }
  return {
    value: {
      kind: 'joint-dispatch',
      resolution: {
        state: 'mapped',
        qualification: current.to,
        revision: domain.revision,
        validationRef: current.validationRef,
      },
    },
  }
}

function plant(head: RouteHead, route: AuthorityRoute): RouteHead | { stop: Stop } {
  if (routeEntry(head, route.logicalAuthorityId))
    return { stop: { code: 'conflict', detail: 'route_exists' } }
  if (route.authorityEpoch < 1) return { stop: { code: 'invalid_input', detail: 'epoch_not_increasing' } }
  return { ...head, routes: { ...head.routes, [route.logicalAuthorityId]: { revision: 1, route } } }
}

function noteActivation(
  head: RouteHead,
  input: { logicalAuthorityId: string; authorityEpoch: number; cutoverId: string },
): RouteHead | { stop: Stop } {
  const stored = routeEntry(head, input.logicalAuthorityId)
  if (!stored) return { stop: { code: 'incompatible', detail: 'route_absent' } }
  if (stored.route.authorityEpoch !== input.authorityEpoch || stored.route.cutoverId !== input.cutoverId) {
    return { stop: { code: 'conflict', detail: 'activation_mismatch' } }
  }
  if (isActive(head, stored.route)) return head
  return {
    ...head,
    activations: head.activations
      .filter((entry) => entry.logicalAuthorityId !== input.logicalAuthorityId)
      .concat(input),
  }
}

function memberAligned(
  route: AuthorityRoute,
  authority: StateAuthorityRef,
  binding: AuthorityRoute['providerBinding'],
  cohortDigest: string,
): boolean {
  return memberIdentity(route, authority, binding) && route.cohortDigest === cohortDigest
}

function memberIdentity(
  route: AuthorityRoute,
  authority: StateAuthorityRef,
  binding: AuthorityRoute['providerBinding'],
): boolean {
  return (
    route.logicalAuthorityId === authority.authorityId &&
    route.tenantId === authority.tenantId &&
    route.authorityEpoch === authority.authorityEpoch &&
    sameBinding(route.providerBinding, binding)
  )
}

function sameBinding(
  left: AuthorityRoute['providerBinding'],
  right: AuthorityRoute['providerBinding'],
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.contract === right.contract &&
    left.logicalName === right.logicalName &&
    left.providerId === right.providerId
  )
}

function sameContainer(left: StateAuthorityRef, right: StateAuthorityRef): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.tenantId === right.tenantId &&
    left.authorityEpoch === right.authorityEpoch
  )
}

function isActive(head: RouteHead, route: AuthorityRoute): boolean {
  return head.activations.some(
    (item) =>
      item.logicalAuthorityId === route.logicalAuthorityId &&
      item.authorityEpoch === route.authorityEpoch &&
      item.cutoverId === route.cutoverId,
  )
}

function orderId(left: string, right: string): number {
  const first = Buffer.from(left)
  const second = Buffer.from(right)
  const length = Math.min(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    const gap = (first[index] ?? 0) - (second[index] ?? 0)
    if (gap !== 0) return gap
  }
  return first.length - second.length
}

function journalBody(
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

function movedReceipt(
  upgradeId: string,
  state: MigrationReceipt['state'],
  checkpointRevision: number,
  cutoverId: string | null,
): MigrationReceipt {
  return { upgradeId, state, checkpointRevision, cutoverId, commitRef: cutoverId, diagnosticIds: [] }
}

function emptyOwned(authority: StateAuthorityRef, epoch: number): RouteHead {
  return {
    writerEpoch: 1,
    directoryEpoch: authority.authorityEpoch,
    locatorEpoch: epoch,
    fenced: false,
    moveOwner: null,
    authority,
    routes: {},
    domains: {},
    activations: [],
  }
}

function readHead(file: string, fallback: RouteHead): Outcome<RouteHead> {
  return immediate(file, (db) => takeHead(db, fallback))
}

function takeHead(db: DatabaseSync, fallback: RouteHead): Outcome<RouteHead> {
  const row = db.prepare('SELECT payload FROM route_head WHERE slot = 1').get() as
    | { payload: string }
    | undefined
  if (!row) return { ok: true, value: fallback }
  try {
    const head = JSON.parse(row.payload) as RouteHead
    if (
      !head ||
      !validateRuntime('StateAuthorityRef', head.authority).ok ||
      typeof head.fenced !== 'boolean' ||
      (head.moveOwner !== null && typeof head.moveOwner !== 'string') ||
      !head.routes ||
      !head.domains ||
      !Array.isArray(head.activations) ||
      ![head.writerEpoch, head.directoryEpoch, head.locatorEpoch].every(
        (epoch) => Number.isSafeInteger(epoch) && epoch >= 1,
      )
    )
      return halt('incompatible', 'directory_corrupt')
    for (const row of Object.values(head.routes))
      if (
        !row ||
        !validateRuntime('AuthorityRoute', row.route).ok ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        return halt('incompatible', 'directory_corrupt')
    for (const entry of Object.values(head.domains))
      if (
        !entry ||
        !validateRuntime('JointDispatchMigrationMapping', entry.latest).ok ||
        !Number.isSafeInteger(entry.revision)
      )
        return halt('incompatible', 'directory_corrupt')
    if (
      head.activations.some(
        (entry) =>
          !entry ||
          !validateRuntime('Id', entry.logicalAuthorityId).ok ||
          !validateRuntime('UInt53', entry.authorityEpoch).ok ||
          !validateRuntime('Id', entry.cutoverId).ok,
      )
    )
      return halt('incompatible', 'directory_corrupt')
    return { ok: true, value: head }
  } catch {
    return halt('incompatible', 'directory_corrupt')
  }
}

function readCutover(file: string, id: string): CutoverRow | null {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    ensureStore(db)
    return takeCutover(db, id)
  } finally {
    db.close()
  }
}

function takeCutover(db: DatabaseSync, id: string): CutoverRow | null {
  const row = db
    .prepare('SELECT fingerprint, result_json FROM route_cutover WHERE cutover_key = ?')
    .get(id) as { fingerprint: string; result_json: string } | undefined
  if (!row) return null
  return {
    fingerprint: row.fingerprint,
    result: JSON.parse(row.result_json) as AuthorityDirectoryCompareAndSwapResult,
  }
}

function takeApproval(
  db: DatabaseSync,
  key: string,
): { validationDigest: string; authorityIds: string[] } | null {
  const row = db.prepare('SELECT payload FROM route_approval WHERE upgrade_key = ?').get(key) as
    | { payload: string }
    | undefined
  return row ? (JSON.parse(row.payload) as { validationDigest: string; authorityIds: string[] }) : null
}

function putHead(db: DatabaseSync, head: RouteHead): void {
  db.prepare(
    'INSERT INTO route_head(slot, payload) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET payload = excluded.payload',
  ).run(JSON.stringify(head))
}

function putCutover(
  db: DatabaseSync,
  id: string,
  fingerprint: string,
  result: AuthorityDirectoryCompareAndSwapResult,
): void {
  db.prepare('INSERT INTO route_cutover(cutover_key, fingerprint, result_json) VALUES (?, ?, ?)').run(
    id,
    fingerprint,
    JSON.stringify(result),
  )
}

function cloneRows(from: string, to: string): void {
  mkdirSync(resolve(to, '..'), { recursive: true, mode: 0o700 })
  const source = new DatabaseSync(from)
  const target = new DatabaseSync(to)
  try {
    target.exec('PRAGMA synchronous=FULL')
    ensureStore(target)
    const head = source.prepare('SELECT payload FROM route_head WHERE slot = 1').get() as
      | { payload: string }
      | undefined
    target.exec('BEGIN IMMEDIATE')
    if (head) target.prepare('INSERT INTO route_head(slot, payload) VALUES (1, ?)').run(head.payload)
    for (const [table, fields] of [
      ['route_cutover', ['cutover_key', 'fingerprint', 'result_json']],
      ['route_approval', ['upgrade_key', 'payload']],
      ['domain_origin', ['domain_id', 'qualification_digest']],
    ] as const) {
      const insert = target.prepare(
        `INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      )
      for (const row of source.prepare(`SELECT ${fields.join(',')} FROM ${table}`).iterate()) {
        insert.run(...fields.map((field) => row[field] ?? null))
      }
    }
    target.exec('COMMIT')
  } finally {
    source.close()
    target.close()
  }
}

function immediate<T>(file: string, body: (db: DatabaseSync) => Outcome<T>): Outcome<T> {
  try {
    return transact(file, body)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('durability phase')) throw error
    return halt('retryable', 'directory_unavailable')
  }
}

function transact<T>(file: string, body: (db: DatabaseSync) => Outcome<T>): Outcome<T> {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA synchronous=FULL')
    ensureStore(db)
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch {
      return halt('conflict', 'directory_busy')
    }
    try {
      const outcome = body(db)
      db.exec(outcome.ok ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* The immediate transaction ends with the handle. */
      }
      throw error
    }
  } finally {
    db.close()
  }
}

function immediateAnchor<T>(file: string, body: (db: DatabaseSync) => Outcome<T>): Outcome<T> {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA synchronous=FULL')
    ensureAnchor(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      const outcome = body(db)
      db.exec(outcome.ok ? 'COMMIT' : 'ROLLBACK')
      return outcome
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* released on close */
      }
      throw error
    }
  } finally {
    db.close()
  }
}

function ensureStore(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS route_approval (upgrade_key TEXT PRIMARY KEY, payload TEXT NOT NULL)')
  db.exec(
    'CREATE TABLE IF NOT EXISTS domain_origin (domain_id TEXT NOT NULL, qualification_digest TEXT NOT NULL, PRIMARY KEY(domain_id, qualification_digest))',
  )

  db.exec(
    `CREATE TABLE IF NOT EXISTS route_head (slot INTEGER PRIMARY KEY CHECK (slot = 1), payload TEXT NOT NULL)`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS route_cutover (cutover_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL)`,
  )
}

function ensureAnchor(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS anchor_view (slot INTEGER PRIMARY KEY CHECK (slot = 1), payload TEXT NOT NULL)`,
  )
  db.exec(`CREATE TABLE IF NOT EXISTS anchor_note (note_key TEXT PRIMARY KEY, payload TEXT NOT NULL)`)
}

function loadAnchor(
  anchor: string,
  principalRef: string,
): Outcome<{ locator: ReferenceLocator; credential: ReferenceCredential }> {
  const opened = readReferenceAnchor(anchor)
  if (!opened.ok) return opened
  if (!opened.value) return halt('incompatible', 'anchor_absent')
  if (opened.value.credential.principalRef !== principalRef) return halt('denied', 'maintenance_principal')
  if (opened.value.credential.directoryId !== opened.value.locator.directoryId)
    return halt('incompatible', 'anchor_corrupt')
  return { ok: true, value: opened.value }
}

function parseAnchor(
  text: string,
): Outcome<{ locator: ReferenceLocator; credential: ReferenceCredential } | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return halt('incompatible', 'anchor_corrupt')
  }
  if (!parsed || typeof parsed !== 'object') return halt('incompatible', 'anchor_corrupt')
  const record = parsed as { locator?: unknown; credential?: unknown }
  const locator = checkLocator(record.locator)
  if (!locator.ok) return halt('incompatible', 'anchor_corrupt')
  const credentialValue = record.credential as ReferenceCredential | undefined
  if (
    !credentialValue ||
    !validateRuntime('Id', credentialValue.principalRef).ok ||
    !validateRuntime('Id', credentialValue.directoryId).ok ||
    !validateRuntime('Digest', credentialValue.credentialDigest).ok
  ) {
    return halt('incompatible', 'anchor_corrupt')
  }
  const expected = credential(credentialValue.principalRef, credentialValue.directoryId)
  if (
    expected.credentialDigest !== credentialValue.credentialDigest ||
    credentialValue.directoryId !== locator.value.directoryId
  ) {
    return halt('incompatible', 'anchor_corrupt')
  }
  return { ok: true, value: { locator: locator.value, credential: credentialValue } }
}

function checkLocator(value: unknown): Outcome<ReferenceLocator> {
  if (!value || typeof value !== 'object') return halt('invalid_input', 'schema')
  const locator = value as ReferenceLocator
  if (
    !validateRuntime('Id', locator.directoryId).ok ||
    !validateRuntime('DataRef', locator.providerLockRef).ok ||
    !validateRuntime('Id', locator.endpointRef).ok ||
    !validateRuntime('UInt53', locator.epoch).ok ||
    !validateRuntime('UInt53', locator.revision).ok ||
    !validateRuntime('Id', locator.cutoverId).ok
  ) {
    return halt('invalid_input', 'schema')
  }
  if (locator.epoch < 1 || locator.revision < 1) return halt('invalid_input', 'epoch_not_increasing')
  return { ok: true, value: locator }
}

function credential(principalRef: string, directoryId: string): ReferenceCredential {
  return {
    principalRef,
    directoryId,
    credentialDigest: canonicalJsonDigest({ principalRef, directoryId } as JsonValue),
  }
}

function localSqliteLocation(directory: string): boolean {
  try {
    let parent = resolve(directory)
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
    switch (statfsSync(parent).type) {
      case 1:
      case 4:
      case 17:
      case 26:
      case 0xef53:
      case 0x58465342:
      case 0x9123683e:
      case 0x01021994:
      case 0x794c7630:
      case 0x2fc12fc1:
        return true
      default:
        return false
    }
  } catch {
    return false
  }
}

function physicalLocation(value: string): string {
  const tail: string[] = []
  let prefix = resolve(value)
  while (!existsSync(prefix) && dirname(prefix) !== prefix) {
    tail.unshift(basename(prefix))
    prefix = dirname(prefix)
  }
  return resolve(realpathSync(prefix), ...tail)
}

function separated(left: string, right: string): boolean {
  const first = physicalLocation(left)
    .split(sep)
    .filter((part) => part !== '')
  const second = physicalLocation(right)
    .split(sep)
    .filter((part) => part !== '')
  if (first.join('/') === second.join('/')) return false
  const nests = (outer: string[], inner: string[]) =>
    inner.length > outer.length && outer.every((part, index) => inner[index] === part)
  return !nests(first, second) && !nests(second, first)
}

function anchorFile(anchor: string): string {
  return resolve(anchor, 'anchor.sqlite')
}

function missingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'SQLITE_CANTOPEN')
  )
}

function halt(code: Stop['code'], detail: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode: detail,
      message: 'Reference directory refused the request',
      retryAdvice: { kind: code === 'retryable' ? 'retry_same_action' : 'never' },
      diagnosticId: 'reference-authority-directory',
    },
  }
}

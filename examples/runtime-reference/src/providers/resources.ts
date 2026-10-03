import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  BindingRef,
  DataRef,
  ReceiptPointer,
  ResourceDescriptor,
  ResourcesDescribeRequest,
  ResourcesListRequest,
  ResourcesRegisterRequest,
  ResourcesReleaseRequest,
  ResourcesRemoveRequest,
  ResourcesRetainRequest,
  RetentionRef,
  RuntimeError,
  SchemaRef,
  ScopeRef,
} from '@agnes/protocol/runtime'
import { validateRuntime as decode, canonicalJsonDigest as hash } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync, syncDirectorySync } from '@agnes/system-node'

export type ReferenceResourcesInput = {
  directory: string
  scope: ScopeRef
  authorize(method: string, resource: ResourceDescriptor | null, context: CallContext): boolean
  contributionReady(resource: ResourceDescriptor, releaseSetId: string): boolean
  schemaAvailable(schema: SchemaRef): boolean
  discover(
    event: 'resources_discover',
    resources: readonly ResourceDescriptor[],
    context: CallContext,
  ): Promise<void>
  /** Optional package-pin ledger. The reference journal does not import the default pin module. */
  externalLedger?: {
    keep(
      pin: { pinId: string; releaseSetId: string; ownerKind: string; ownerId: string },
      ctx: CallContext,
    ): Promise<Outcome<DataRef>>
    current(ctx: CallContext): Promise<Outcome<DataRef[]>>
  }
  /** Invoked once a pending pin has been fsynced, before that pin is confirmed. */
  holdPin?: () => Promise<void>
}
type Cabinet = {
  scope: string
  revision: number
  records: Array<{ descriptor: ResourceDescriptor; release: string }>
}
const requestTypes = new Map([
  ['list', 'ResourcesListRequest'],
  ['describe', 'ResourcesDescribeRequest'],
  ['register', 'ResourcesRegisterRequest'],
  ['remove', 'ResourcesRemoveRequest'],
  ['retain', 'ResourcesRetainRequest'],
  ['release', 'ResourcesReleaseRequest'],
] as const)
type QueryName = 'list' | 'describe' | 'register' | 'remove' | 'retain' | 'release'
class Refusal extends Error {
  constructor(
    public category: RuntimeError['code'],
    public reason: string,
  ) {
    super(reason)
  }
}
function fail(category: RuntimeError['code'], reason: string): never {
  throw new Refusal(category, reason)
}

/** Independent whole-document cabinet. No Host algorithm or retention implementation is imported. */
export function createReferenceResources(input: ReferenceResourcesInput) {
  const workspace = structuredClone(input.scope)
  if (workspace.kind !== 'workspace' || !decode('ScopeRef', workspace).ok)
    throw new Error('resources_workspace_required')
  const scopeKey = hash(workspace)
  if (!existsSync(input.directory)) createPrivateDirectorySync(input.directory)
  const location = join(input.directory, 'cabinet.json')
  // SQLite provides only the cross-process mutex. Catalog records live in the independent cabinet.
  const mutexPath = join(input.directory, 'cabinet-mutex.sqlite')
  if (!existsSync(mutexPath)) closeSync(createPrivateFileSync(mutexPath))
  const mutex = new DatabaseSync(mutexPath)
  let ended = false
  const stopping = new AbortController()
  const binding: BindingRef = {
    providerId: 'agh.reference/resources',
    bindingId: 'agh.reference/resources/binding',
    logicalName: 'resources',
    contract: 'agh.resources',
  }
  function read(): Cabinet {
    if (!existsSync(location)) return { scope: scopeKey, revision: 0, records: [] }
    const state = JSON.parse(readFileSync(location, 'utf8')) as Cabinet
    if (state.scope !== scopeKey) throw new Error('resources_scope_mismatch')
    if (
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !Array.isArray(state.records) ||
      state.records.some(
        (r) => !decode('ResourceDescriptor', r.descriptor).ok || typeof r.release !== 'string',
      ) ||
      new Set(state.records.map((r) => r.descriptor.id)).size !== state.records.length
    )
      fail('incompatible', 'resources_catalog_corrupt')
    return state
  }
  function save(state: Cabinet): void {
    const temp = `${location}.${randomUUID()}.pending`
    const fd = openSync(temp, 'wx', 0o600)
    let renamed = false
    try {
      try {
        writeFileSync(fd, JSON.stringify(state))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, location)
      renamed = true
      syncDirectorySync(input.directory)
    } catch (error) {
      if (renamed) fail('unknown_effect', 'resources_write_unknown')
      throw error
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  try {
    read()
  } catch (error) {
    mutex.close()
    throw error
  }
  const checkCall = (ctx: CallContext) => {
    if (ended) fail('denied', 'resources_closed')
    if (
      ctx.signal.aborted ||
      !Number.isFinite(Date.parse(ctx.deadline)) ||
      Date.parse(ctx.deadline) <= Date.now()
    )
      fail('cancelled', 'resources_cancelled')
    if (
      !('workspaceId' in ctx.scope) ||
      ctx.scope.workspaceId !== workspace.workspaceId ||
      ctx.scope.installationId !== workspace.installationId ||
      ctx.scope.runtimeId !== workspace.runtimeId
    )
      fail('denied', 'resources_scope')
  }
  const allow = (operation: string, descriptor: ResourceDescriptor | null, ctx: CallContext) => {
    if (input.authorize(operation, descriptor === null ? null : structuredClone(descriptor), ctx) !== true)
      fail('denied', 'resources_denied')
  }
  function usable(record: Cabinet['records'][number]): void {
    if (input.contributionReady(structuredClone(record.descriptor), record.release) !== true)
      fail('retryable', 'resources_not_ready')
    const definitions = [record.descriptor.inputSchema, record.descriptor.outputSchema].filter(
      (s) => s !== null,
    )
    if (definitions.some((s) => input.schemaAvailable(structuredClone(s)) !== true))
      fail('incompatible', 'resources_schema_stale')
  }
  async function notify(rows: ResourceDescriptor[], ctx: CallContext) {
    const expired = new AbortController()
    const timer = setTimeout(
      () => expired.abort(),
      Math.min(2_147_483_647, Math.max(1, Date.parse(ctx.deadline) - Date.now())),
    )
    const signal = AbortSignal.any([ctx.signal, expired.signal, stopping.signal])
    const hookCall = Object.freeze({ ...ctx, signal, scope: Object.freeze(structuredClone(ctx.scope)) })
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cleanup()
          reject(
            stopping.signal.aborted
              ? new Refusal('denied', 'resources_closed')
              : new Refusal('cancelled', 'resources_cancelled'),
          )
        }
        const cleanup = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve()
          .then(() => {
            if (signal.aborted) return
            return input.discover('resources_discover', structuredClone(rows), hookCall)
          })
          .then(
            () => {
              cleanup()
              resolve()
            },
            (error) => {
              cleanup()
              reject(error)
            },
          )
      })
      checkCall(ctx)
    } finally {
      clearTimeout(timer)
    }
  }
  function locate(state: Cabinet, id: string): Cabinet['records'][number] {
    const record = state.records.find((r) => r.descriptor.id === id)
    return record ?? fail('invalid_input', 'resources_not_found')
  }
  function visible(state: Cabinet, query: ResourcesListRequest, ctx: CallContext): ResourceDescriptor[] {
    return state.records
      .filter((record) => {
        const d = record.descriptor
        if (d.kind !== query.kind) return false
        if (query.filter.namespace !== undefined && query.filter.namespace !== d.namespace) return false
        if ((query.filter.tags ?? []).some((t) => !d.tags.includes(t))) return false
        try {
          allow('list', d, ctx)
          usable(record)
          return true
        } catch (e) {
          if (e instanceof Refusal) return false
          throw e
        }
      })
      .map((r) => r.descriptor)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  type Seen = { id: string; version: string; digest: string }
  type Held = {
    pinId: string
    resourceId: string
    version: string
    digest: string
    ownerId: string
    purpose: string
    releaseSetId: string
    status: 'pending' | 'confirmed' | 'release-pending' | 'released'
    packageState: 'none' | 'bound' | 'uncertain'
    packageDigest: string | null
  }
  type Intent = { pinId: string; reason: string; receiptId: string; digest: string }
  type Ledger = { seen: Seen[]; held: Held[]; intents: Intent[] }
  const ledgerPath = join(input.directory, 'retention-ledger.json')
  const drafting = new Set<string>()
  let turn = Promise.resolve()
  const alone = <T>(step: () => Promise<T>) => {
    const next = turn.then(step, step)
    turn = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  function emptyLedger(): Ledger {
    return { seen: [], held: [], intents: [] }
  }
  function loadLedger(): Ledger {
    if (!existsSync(ledgerPath)) return emptyLedger()
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger
    if (
      !parsed ||
      !Array.isArray(parsed.seen) ||
      !Array.isArray(parsed.held) ||
      !Array.isArray(parsed.intents)
    )
      fail('incompatible', 'resources_pin_corrupt')
    return parsed
  }
  function storeLedger(ledger: Ledger): void {
    const temp = `${ledgerPath}.${randomUUID()}.draft`
    const fd = openSync(temp, 'wx', 0o600)
    let moved = false
    try {
      try {
        writeFileSync(fd, JSON.stringify(ledger))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, ledgerPath)
      moved = true
      syncDirectorySync(input.directory)
    } catch (error) {
      if (moved) fail('unknown_effect', 'resources_pin_uncertain')
      throw error
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  function withLedger<T>(change: (ledger: Ledger) => T): T {
    mutex.exec('BEGIN IMMEDIATE')
    try {
      const ledger = loadLedger()
      const value = change(ledger)
      storeLedger(ledger)
      return value
    } finally {
      mutex.exec('ROLLBACK')
    }
  }
  function remember(items: readonly ResourceDescriptor[]): void {
    if (items.length === 0) return
    withLedger((ledger) => {
      for (const item of items) {
        const known = ledger.seen.some(
          (entry) => entry.id === item.id && entry.version === item.version && entry.digest === item.digest,
        )
        if (!known) ledger.seen.push({ id: item.id, version: item.version, digest: item.digest })
      }
    })
  }
  function ledgerKey(resourceId: string, version: string, digest: string, ownerId: string, purpose: string) {
    return `rp-${hash({ digest, ownerId, purpose, resourceId, version })}`
  }
  function kindFor(purpose: string) {
    if (purpose === 'job') return 'job'
    if (purpose === 'history') return 'reader'
    return 'action'
  }
  function rejectedPackage(code: string) {
    return (
      code === 'release_route_unavailable' ||
      code === 'release_digest_mismatch' ||
      code === 'package_pin_conflict' ||
      code === 'schema_invalid' ||
      code === 'maintenance_denied' ||
      code === 'maintenance_cancelled' ||
      code === 'production_inputs_unavailable' ||
      code === 'maintenance_record_mismatch'
    )
  }
  function asRetention(row: Held): RetentionRef {
    const value: RetentionRef = {
      kind: 'domain-record',
      authorityId: 'agh.resources',
      resourceId: row.resourceId,
      version: row.version,
      digest: row.digest,
      pinId: row.pinId,
    }
    if (!decode('RetentionRef', value).ok) fail('incompatible', 'resources_pin_corrupt')
    return value
  }
  function packageDigest(ref: DataRef, row: Held) {
    if (
      ref.kind !== 'inline' ||
      ref.value === null ||
      typeof ref.value !== 'object' ||
      Array.isArray(ref.value)
    )
      fail('retryable', 'resources_pin_uncertain')
    const body = ref.value as Record<string, unknown>
    if (body.pinId !== row.pinId || body.ownerId !== row.ownerId || body.releaseSetId !== row.releaseSetId)
      fail('retryable', 'resources_pin_uncertain')
    if (body.status !== 'active') fail('retryable', 'resources_pin_uncertain')
    return ref.digest
  }
  async function attachLedger(row: Held, ctx: CallContext, creating: boolean) {
    const bridge = input.externalLedger
    if (!bridge || ctx.principalRef !== row.ownerId) return
    let outcome: Outcome<DataRef>
    try {
      outcome = await bridge.keep(
        {
          pinId: row.pinId,
          releaseSetId: row.releaseSetId,
          ownerKind: kindFor(row.purpose),
          ownerId: row.ownerId,
        },
        ctx,
      )
    } catch {
      withLedger((ledger) => {
        const found = ledger.held.find((item) => item.pinId === row.pinId)
        if (found) found.packageState = 'uncertain'
      })
      if (creating) fail('retryable', 'resources_pin_uncertain')
      return
    }
    if (!outcome.ok) {
      if (creating && rejectedPackage(outcome.error.detailCode)) {
        withLedger((ledger) => {
          ledger.held = ledger.held.filter((item) => item.pinId !== row.pinId || item.status !== 'pending')
        })
        fail('incompatible', 'resources_package_pin_rejected')
      }
      withLedger((ledger) => {
        const found = ledger.held.find((item) => item.pinId === row.pinId)
        if (found) found.packageState = 'uncertain'
      })
      if (creating) fail('retryable', 'resources_pin_uncertain')
      return
    }
    let digest: string
    try {
      digest = packageDigest(outcome.value, row)
    } catch (error) {
      withLedger((ledger) => {
        const found = ledger.held.find((item) => item.pinId === row.pinId)
        if (found) found.packageState = 'uncertain'
      })
      if (creating) throw error
      return
    }
    withLedger((ledger) => {
      const found = ledger.held.find((item) => item.pinId === row.pinId)
      if (!found) return
      found.packageState = 'bound'
      found.packageDigest = digest
    })
  }
  function promote(pinId: string) {
    withLedger((ledger) => {
      const found = ledger.held.find((item) => item.pinId === pinId && item.status === 'pending')
      if (found) found.status = 'confirmed'
    })
  }
  async function recover(ctx: CallContext) {
    const waiting = loadLedger().held.filter((item) => item.status === 'pending' && !drafting.has(item.pinId))
    for (const item of waiting) {
      await attachLedger(item, ctx, false)
      promote(item.pinId)
    }
  }
  async function publish(row: Held, ctx: CallContext) {
    drafting.add(row.pinId)
    try {
      if (input.holdPin) await input.holdPin()
      checkCall(ctx)
      await attachLedger(row, ctx, true)
      promote(row.pinId)
      const saved = loadLedger().held.find((item) => item.pinId === row.pinId)
      if (!saved || saved.status === 'pending') fail('retryable', 'resources_pin_uncertain')
      return asRetention(saved)
    } finally {
      drafting.delete(row.pinId)
    }
  }
  async function keepResource(request: ResourcesRetainRequest, ctx: CallContext) {
    if (request.resource.kind !== 'resource') fail('invalid_input', 'resources_not_resource')
    const wanted = request.resource.value
    const seen = loadLedger().seen.some(
      (entry) =>
        entry.id === wanted.resourceId && entry.version === wanted.version && entry.digest === wanted.digest,
    )
    if (!seen) fail('denied', 'resources_not_discovered')
    return alone(async () => {
      await recover(ctx)
      const chosen = withLedger((ledger) => {
        const active = ledger.held.filter(
          (item) =>
            item.resourceId === wanted.resourceId &&
            item.version === wanted.version &&
            item.digest === wanted.digest &&
            item.status !== 'released',
        )
        const same = active.find(
          (item) => item.ownerId === ctx.principalRef && item.purpose === request.purpose,
        )
        if (same) return same
        if (active.length > 0) fail('denied', 'resources_pin_required')
        const state = read()
        const record = state.records.find((item) => item.descriptor.id === wanted.resourceId)
        if (!record) fail('invalid_input', 'resources_not_found')
        if (record.descriptor.version !== wanted.version || record.descriptor.digest !== wanted.digest)
          fail('conflict', 'resources_version_stale')
        allow('retain', record.descriptor, ctx)
        usable(record)
        const pinId = ledgerKey(
          wanted.resourceId,
          wanted.version,
          wanted.digest,
          ctx.principalRef,
          request.purpose,
        )
        const prior = ledger.held.find((item) => item.pinId === pinId)
        if (prior && prior.status === 'released') {
          prior.status = 'pending'
          prior.packageState = 'none'
          prior.packageDigest = null
          prior.releaseSetId = record.release
          ledger.intents = ledger.intents.filter((item) => item.pinId !== pinId)
          return prior
        }
        const created: Held = {
          pinId,
          resourceId: wanted.resourceId,
          version: wanted.version,
          digest: wanted.digest,
          ownerId: ctx.principalRef,
          purpose: request.purpose,
          releaseSetId: record.release,
          status: 'pending',
          packageState: 'none',
          packageDigest: null,
        }
        ledger.held.push(created)
        return created
      })
      if (chosen.status === 'confirmed' || chosen.status === 'release-pending') return asRetention(chosen)
      return publish(chosen, ctx)
    })
  }
  function receiptFor(row: Held, reason: string): ReceiptPointer {
    const digest = hash({
      digest: row.digest,
      pinId: row.pinId,
      reason,
      resourceId: row.resourceId,
      version: row.version,
    })
    const receipt: ReceiptPointer = {
      authorityId: 'agh.resources',
      receiptId: `release-${row.pinId}`,
      digest,
    }
    if (!decode('ReceiptPointer', receipt).ok) fail('incompatible', 'resources_pin_corrupt')
    return receipt
  }
  async function stillReferenced(row: Held, ctx: CallContext) {
    const ledger = loadLedger()
    const sibling = ledger.held.some(
      (item) =>
        item.pinId !== row.pinId &&
        item.resourceId === row.resourceId &&
        item.version === row.version &&
        item.digest === row.digest &&
        item.status !== 'released',
    )
    if (sibling || row.packageState === 'uncertain') return true
    if (row.packageState !== 'bound' || !input.externalLedger) return row.packageState === 'bound'
    const active = await input.externalLedger.current(ctx)
    if (!active.ok) return true
    return active.value.some((ref) => {
      if (
        ref.kind !== 'inline' ||
        ref.value === null ||
        typeof ref.value !== 'object' ||
        Array.isArray(ref.value)
      )
        return true
      return (ref.value as { pinId?: unknown }).pinId === row.pinId
    })
  }
  async function dropResource(request: ResourcesReleaseRequest, ctx: CallContext) {
    const claim = request.retention
    if (claim.kind !== 'domain-record' || claim.authorityId !== 'agh.resources')
      fail('conflict', 'resources_pin_mismatch')
    return alone(async () => {
      await recover(ctx)
      const row = loadLedger().held.find((item) => item.pinId === claim.pinId)
      if (!row) fail('invalid_input', 'resources_pin_unknown')
      if (row.resourceId !== claim.resourceId || row.version !== claim.version || row.digest !== claim.digest)
        fail('conflict', 'resources_pin_mismatch')
      if (row.ownerId !== ctx.principalRef) fail('denied', 'resources_pin_required')
      const existing = loadLedger().intents.find((item) => item.pinId === row.pinId)
      if (existing && existing.reason !== request.reason) fail('conflict', 'resources_release_conflict')
      const receipt = receiptFor(row, request.reason)
      if (!existing) {
        withLedger((ledger) => {
          ledger.intents.push({
            pinId: row.pinId,
            reason: request.reason,
            receiptId: receipt.receiptId,
            digest: receipt.digest,
          })
        })
      }
      const live = await stillReferenced(row, ctx)
      const status = live ? 'release-pending' : 'released'
      withLedger((ledger) => {
        const found = ledger.held.find((item) => item.pinId === row.pinId)
        if (found) found.status = status
      })
      return { state: status, receipt }
    })
  }
  async function execute(operation: string, argument: unknown, ctx: CallContext): Promise<unknown> {
    checkCall(ctx)
    const type = requestTypes.get(operation as QueryName)
    if (!type) fail('incompatible', 'resources_unknown_method')
    const decoded = decode(type, argument)
    if (!decoded.ok) fail('invalid_input', 'resources_input_schema')
    allow(operation, null, ctx)
    if (operation === 'retain') return keepResource(decoded.value as ResourcesRetainRequest, ctx)
    if (operation === 'release') return dropResource(decoded.value as ResourcesReleaseRequest, ctx)
    const mutation = operation === 'register' || operation === 'remove'
    if (mutation) mutex.exec('BEGIN IMMEDIATE')
    try {
      const state = read()
      switch (operation) {
        case 'register': {
          const body = decoded.value as ResourcesRegisterRequest
          const record = { descriptor: body.descriptor, release: body.ownerReleaseSetId }
          allow(operation, body.descriptor, ctx)
          usable(record)
          const current = state.records.findIndex((r) => r.descriptor.id === body.descriptor.id)
          if (current >= 0 && state.records[current]?.descriptor.version === body.descriptor.version) {
            if (hash(state.records[current]) !== hash(record)) fail('conflict', 'resources_version_conflict')
            fail('conflict', 'resources_duplicate_registration')
          }
          if (current < 0) state.records.push(record)
          else state.records.splice(current, 1, record)
          state.revision += 1
          save(state)
          return { revision: state.revision }
        }
        case 'remove': {
          const body = decoded.value as ResourcesRemoveRequest
          const found = locate(state, body.id)
          allow(operation, found.descriptor, ctx)
          if (state.revision !== body.expectedRevision) fail('conflict', 'resources_revision_conflict')
          state.records = state.records.filter((r) => r.descriptor.id !== body.id)
          state.revision += 1
          save(state)
          return { revision: state.revision }
        }
        case 'describe': {
          const body = decoded.value as ResourcesDescribeRequest
          const record = locate(state, body.resourceId)
          allow(operation, record.descriptor, ctx)
          usable(record)
          if (body.version !== null && body.version !== record.descriptor.version)
            fail('conflict', 'resources_version_stale')
          await notify([record.descriptor], ctx)
          if (state.revision !== read().revision) fail('conflict', 'resources_snapshot_stale')
          allow(operation, record.descriptor, ctx)
          usable(record)
          remember([record.descriptor])
          return structuredClone(record.descriptor)
        }
        default: {
          const body = decoded.value as ResourcesListRequest
          if (body.limit === 0 || body.limit > 100) fail('invalid_input', 'resources_limit')
          const rows = visible(state, body, ctx)
          const snapshot = hash({
            scope: scopeKey,
            revision: state.revision,
            principal: ctx.principalRef,
            authorization: ctx.authorizationRef,
            request: { ...body, cursor: null },
            found: rows,
          })
          let start = 0
          if (body.cursor !== null) {
            let bookmark: { snapshot: string; offset: number }
            try {
              bookmark = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8'))
            } catch {
              fail('conflict', 'resources_cursor_stale')
            }
            if (
              bookmark.snapshot !== snapshot ||
              !Number.isSafeInteger(bookmark.offset) ||
              bookmark.offset < 1 ||
              bookmark.offset >= rows.length
            )
              fail('conflict', 'resources_cursor_stale')
            start = bookmark.offset
          }
          const stop = Math.min(start + body.limit, rows.length)
          await notify(rows.slice(start, stop), ctx)
          allow(operation, null, ctx)
          const refreshed = read()
          if (state.revision !== refreshed.revision || hash(visible(refreshed, body, ctx)) !== hash(rows))
            fail('conflict', 'resources_snapshot_stale')
          const more = stop < rows.length
          remember(rows.slice(start, stop))
          return {
            items: structuredClone(rows.slice(start, stop)),
            snapshot,
            complete: !more,
            nextCursor: more
              ? Buffer.from(JSON.stringify({ snapshot, offset: stop })).toString('base64url')
              : null,
          }
        }
      }
    } finally {
      if (mutation) mutex.exec('ROLLBACK')
    }
  }
  return {
    binding,
    implemented: ['list', 'describe', 'register', 'remove', 'retain', 'release'],
    incomplete: ['production-wiring'],
    async call(operation: string, argument: unknown, ctx: CallContext): Promise<Outcome<unknown>> {
      try {
        return { ok: true, value: await execute(operation, argument, ctx) }
      } catch (cause) {
        const fault =
          cause instanceof Refusal ? cause : new Refusal('retryable', 'resources_dependency_unavailable')
        return {
          ok: false,
          error: {
            code: fault.category,
            detailCode: fault.reason,
            message: 'Resource request refused',
            diagnosticId: 'resources',
            retryAdvice: { kind: 'never' },
          },
        }
      }
    },
    close() {
      if (ended) return
      ended = true
      stopping.abort()
      mutex.close()
    },
  }
}

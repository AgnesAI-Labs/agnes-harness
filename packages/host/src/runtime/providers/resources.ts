import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import type { AssemblyMaintenancePorts } from '../assembly/maintenance-journal.js'
import { createMaintenancePackagePins } from '../assembly/package-pins.js'

export interface ResourcesOptions {
  readonly directory: string
  readonly scope: Wire.ScopeRef
  /** Trusted synchronous deployment checks. No caller assertion grants access/readiness. */
  readonly authorize: (
    method: string,
    resource: Wire.ResourceDescriptor | null,
    context: CallContext,
  ) => boolean
  readonly contributionReady: (resource: Wire.ResourceDescriptor, releaseSetId: string) => boolean
  readonly schemaAvailable: (schema: Wire.SchemaRef) => boolean
  /** Runtime Hook boundary supplied by the selected Hook service, independent of any Loop. */
  readonly discover: (
    event: 'resources_discover',
    resources: readonly Wire.ResourceDescriptor[],
    context: CallContext,
  ) => Promise<void>
  /** Published maintenance journal. Absent means the resource pin is not mapped to a package pin. */
  readonly maintenance?: AssemblyMaintenancePorts
  /** Runs after the pending pin is durable and before it is confirmed. */
  readonly pinGate?: () => Promise<void>
}

export interface ResourcesService {
  readonly binding: Wire.BindingRef
  readonly implemented: readonly string[]
  readonly incomplete: readonly string[]
  call(method: string, input: unknown, context: CallContext): Promise<Outcome<unknown>>
  close(): void
}

class CatalogFault extends Error {
  constructor(
    readonly code: Wire.RuntimeError['code'],
    readonly detail: string,
  ) {
    super(detail)
  }
}
const reject = (code: Wire.RuntimeError['code'], detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Resource request refused',
    diagnosticId: 'resources',
    retryAdvice: { kind: 'never' },
  },
})
const schemas = {
  list: 'ResourcesListRequest',
  describe: 'ResourcesDescribeRequest',
  register: 'ResourcesRegisterRequest',
  remove: 'ResourcesRemoveRequest',
  retain: 'ResourcesRetainRequest',
  release: 'ResourcesReleaseRequest',
} as const
type Method = keyof typeof schemas
type Row = { descriptor: Wire.ResourceDescriptor; release: string }

/** Parallel catalog service; legacy resource control and startup wiring remain separately owned. */
export function createResourcesService(options: ResourcesOptions): ResourcesService {
  const workspace = structuredClone(options.scope)
  if (!validateRuntime('ScopeRef', workspace).ok || workspace.kind !== 'workspace')
    throw new Error('resources_workspace_required')
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const path = join(options.directory, 'catalog.sqlite')
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, scope TEXT NOT NULL)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS discovery (resource_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (resource_id, version, digest)); CREATE TABLE IF NOT EXISTS resource_pin (pin_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, owner_id TEXT NOT NULL, purpose TEXT NOT NULL, release_set_id TEXT NOT NULL, status TEXT NOT NULL, package_state TEXT NOT NULL, package_digest TEXT); CREATE TABLE IF NOT EXISTS release_intent (pin_id TEXT PRIMARY KEY, reason TEXT NOT NULL, receipt_id TEXT NOT NULL, digest TEXT NOT NULL)',
  )
  const scope = canonicalJsonDigest(workspace)
  db.prepare('INSERT OR IGNORE INTO meta VALUES (1, 0, ?)').run(scope)
  if (db.prepare('SELECT scope FROM meta WHERE id=1').get()?.scope !== scope) {
    db.close()
    throw new Error('resources_scope_mismatch')
  }
  let closed = false
  const lifetime = new AbortController()
  const binding: Wire.BindingRef = {
    bindingId: 'agh.default/resources/binding',
    contract: 'agh.resources',
    logicalName: 'resources',
    providerId: 'agh.default/resources',
  }
  const revision = () => Number(db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision)
  const guard = (context: CallContext) => {
    if (closed) throw new CatalogFault('denied', 'resources_closed')
    if (
      context.signal.aborted ||
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= Date.now()
    )
      throw new CatalogFault('cancelled', 'resources_cancelled')
    const current = context.scope
    if (
      !('workspaceId' in current) ||
      current.workspaceId !== workspace.workspaceId ||
      current.installationId !== workspace.installationId ||
      current.runtimeId !== workspace.runtimeId
    )
      throw new CatalogFault('denied', 'resources_scope')
  }
  const permission = (method: string, resource: Wire.ResourceDescriptor | null, context: CallContext) => {
    if (options.authorize(method, resource ? structuredClone(resource) : null, context) !== true)
      throw new CatalogFault('denied', 'resources_denied')
  }
  const available = (row: Row) => {
    if (options.contributionReady(structuredClone(row.descriptor), row.release) !== true)
      throw new CatalogFault('retryable', 'resources_not_ready')
    for (const schema of [row.descriptor.inputSchema, row.descriptor.outputSchema])
      if (schema && options.schemaAvailable(structuredClone(schema)) !== true)
        throw new CatalogFault('incompatible', 'resources_schema_stale')
  }
  const load = (id: string): Row => {
    const stored = db.prepare('SELECT body FROM catalog WHERE id=?').get(id)
    if (!stored) throw new CatalogFault('invalid_input', 'resources_not_found')
    const row = JSON.parse(String(stored.body)) as Row
    if (!validateRuntime('ResourceDescriptor', row.descriptor).ok || typeof row.release !== 'string')
      throw new CatalogFault('incompatible', 'resources_catalog_corrupt')
    return row
  }
  const change = (body: () => void): number => {
    db.exec('BEGIN IMMEDIATE')
    try {
      body()
      db.exec('UPDATE meta SET revision=revision+1 WHERE id=1')
      const next = revision()
      db.exec('COMMIT')
      return next
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  async function discover(
    candidates: readonly Wire.ResourceDescriptor[],
    context: CallContext,
  ): Promise<void> {
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(),
      Math.min(2_147_483_647, Math.max(1, Date.parse(context.deadline) - Date.now())),
    )
    const signal = AbortSignal.any([context.signal, lifetime.signal, timeout.signal])
    let cancel = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(
          lifetime.signal.aborted
            ? new CatalogFault('denied', 'resources_closed')
            : new CatalogFault('cancelled', 'resources_cancelled'),
        )
      signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      const hookContext = Object.freeze({
        ...context,
        signal,
        scope: Object.freeze(structuredClone(context.scope)),
      })
      await Promise.race([
        options.discover('resources_discover', structuredClone(candidates), hookContext),
        interrupted,
      ])
      guard(context)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  }
  const packagePins = options.maintenance ? createMaintenancePackagePins(options.maintenance) : null
  const openPins = new Set<string>()
  let pinQueue = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = pinQueue.then(work, work)
    pinQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  type PinRow = {
    pin_id: string
    resource_id: string
    version: string
    digest: string
    owner_id: string
    purpose: string
    release_set_id: string
    status: string
    package_state: string
    package_digest: string | null
  }
  const immediate = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const pinsFor = (id: string, version: string, digest: string) =>
    db
      .prepare(
        `SELECT * FROM resource_pin WHERE resource_id=? AND version=? AND digest=? AND status!='released'`,
      )
      .all(id, version, digest) as PinRow[]
  const pinById = (pinId: string) =>
    db.prepare('SELECT * FROM resource_pin WHERE pin_id=?').get(pinId) as PinRow | undefined
  const discovered = (id: string, version: string, digest: string) =>
    Boolean(
      db
        .prepare('SELECT 1 AS hit FROM discovery WHERE resource_id=? AND version=? AND digest=?')
        .get(id, version, digest),
    )
  const note = (items: readonly Wire.ResourceDescriptor[]) => {
    const insert = db.prepare('INSERT OR IGNORE INTO discovery VALUES (?, ?, ?)')
    immediate(() => {
      for (const item of items) insert.run(item.id, item.version, item.digest)
    })
  }
  const pinKey = (part: {
    resourceId: string
    version: string
    digest: string
    ownerId: string
    purpose: string
  }) => `rp-${canonicalJsonDigest(part)}`
  const ownerKind = (purpose: string) =>
    purpose === 'job' ? 'job' : purpose === 'history' ? 'reader' : 'action'
  const packageRefusal = (detail: string) =>
    [
      'release_route_unavailable',
      'release_digest_mismatch',
      'package_pin_conflict',
      'schema_invalid',
      'maintenance_denied',
      'maintenance_cancelled',
      'production_inputs_unavailable',
      'maintenance_record_mismatch',
    ].includes(detail)
  const retentionOf = (row: PinRow): Wire.RetentionRef => {
    const value: Wire.RetentionRef = {
      kind: 'domain-record',
      authorityId: 'agh.resources',
      resourceId: row.resource_id,
      version: row.version,
      digest: row.digest,
      pinId: row.pin_id,
    }
    if (!validateRuntime('RetentionRef', value).ok)
      throw new CatalogFault('incompatible', 'resources_pin_corrupt')
    return value
  }
  const readPackage = (ref: Wire.DataRef, row: PinRow) => {
    if (ref.kind !== 'inline' || !ref.value || typeof ref.value !== 'object' || Array.isArray(ref.value))
      throw new CatalogFault('retryable', 'resources_pin_uncertain')
    const body = ref.value as Record<string, unknown>
    if (
      body.pinId !== row.pin_id ||
      body.releaseSetId !== row.release_set_id ||
      body.ownerId !== row.owner_id ||
      body.status !== 'active'
    )
      throw new CatalogFault('retryable', 'resources_pin_uncertain')
    return ref.digest
  }
  async function bindPackage(row: PinRow, context: CallContext, mode: 'create' | 'recover') {
    if (!packagePins || context.principalRef !== row.owner_id) return
    let outcome: Outcome<Wire.DataRef>
    try {
      outcome = await packagePins.retain(
        {
          pinId: row.pin_id,
          releaseSetId: row.release_set_id,
          ownerKind: ownerKind(row.purpose),
          ownerId: row.owner_id,
        },
        context,
      )
    } catch {
      if (mode === 'recover') {
        immediate(() => {
          db.prepare(`UPDATE resource_pin SET package_state='uncertain' WHERE pin_id=?`).run(row.pin_id)
        })
        return
      }
      throw new CatalogFault('retryable', 'resources_pin_uncertain')
    }
    if (!outcome.ok) {
      if (mode === 'create' && packageRefusal(outcome.error.detailCode)) {
        immediate(() => {
          db.prepare('DELETE FROM resource_pin WHERE pin_id=? AND status=?').run(row.pin_id, 'pending')
        })
        throw new CatalogFault('incompatible', 'resources_package_pin_rejected')
      }
      immediate(() => {
        db.prepare(`UPDATE resource_pin SET package_state='uncertain' WHERE pin_id=?`).run(row.pin_id)
      })
      if (mode === 'create') throw new CatalogFault('retryable', 'resources_pin_uncertain')
      return
    }
    let digest: string
    try {
      digest = readPackage(outcome.value, row)
    } catch (error) {
      immediate(() => {
        db.prepare(`UPDATE resource_pin SET package_state='uncertain' WHERE pin_id=?`).run(row.pin_id)
      })
      if (mode === 'create') throw error
      return
    }
    immediate(() => {
      db.prepare(`UPDATE resource_pin SET package_state='bound', package_digest=? WHERE pin_id=?`).run(
        digest,
        row.pin_id,
      )
    })
  }
  const confirmPending = (pinId: string) => {
    immediate(() => {
      db.prepare(`UPDATE resource_pin SET status='confirmed' WHERE pin_id=? AND status='pending'`).run(pinId)
    })
  }
  async function settle(context: CallContext) {
    const pending = db.prepare(`SELECT * FROM resource_pin WHERE status='pending'`).all() as PinRow[]
    for (const row of pending) {
      if (openPins.has(row.pin_id)) continue
      await bindPackage(row, context, 'recover')
      confirmPending(row.pin_id)
    }
  }
  async function finish(row: PinRow, context: CallContext) {
    openPins.add(row.pin_id)
    try {
      await options.pinGate?.()
      guard(context)
      await bindPackage(row, context, 'create')
      confirmPending(row.pin_id)
      const saved = pinById(row.pin_id)
      if (!saved || saved.status === 'pending') throw new CatalogFault('retryable', 'resources_pin_uncertain')
      return retentionOf(saved)
    } finally {
      openPins.delete(row.pin_id)
    }
  }
  async function retain(request: Wire.ResourcesRetainRequest, context: CallContext) {
    if (request.resource.kind !== 'resource')
      throw new CatalogFault('invalid_input', 'resources_not_resource')
    const target = request.resource.value
    if (!discovered(target.resourceId, target.version, target.digest))
      throw new CatalogFault('denied', 'resources_not_discovered')
    return exclusive(async () => {
      await settle(context)
      const decision = immediate(() => {
        const active = pinsFor(target.resourceId, target.version, target.digest)
        const same = active.find(
          (row) => row.owner_id === context.principalRef && row.purpose === request.purpose,
        )
        if (same) return same
        if (active.length > 0) throw new CatalogFault('denied', 'resources_pin_required')
        let row: Row
        try {
          row = load(target.resourceId)
        } catch (error) {
          if (error instanceof CatalogFault && error.detail === 'resources_not_found') throw error
          throw error
        }
        if (row.descriptor.version !== target.version || row.descriptor.digest !== target.digest)
          throw new CatalogFault('conflict', 'resources_version_stale')
        permission('retain', row.descriptor, context)
        available(row)
        const pinId = pinKey({
          resourceId: target.resourceId,
          version: target.version,
          digest: target.digest,
          ownerId: context.principalRef,
          purpose: request.purpose,
        })
        const retired = pinById(pinId)
        if (retired?.status === 'released') {
          db.prepare(
            `UPDATE resource_pin SET status='pending', package_state='none', package_digest=NULL, release_set_id=? WHERE pin_id=?`,
          ).run(row.release, pinId)
          db.prepare('DELETE FROM release_intent WHERE pin_id=?').run(pinId)
        } else {
          db.prepare('INSERT INTO resource_pin VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(
            pinId,
            target.resourceId,
            target.version,
            target.digest,
            context.principalRef,
            request.purpose,
            row.release,
            'pending',
            'none',
          )
        }
        return pinById(pinId) as PinRow
      })
      if (decision.status === 'confirmed' || decision.status === 'release-pending')
        return retentionOf(decision)
      return finish(decision, context)
    })
  }
  const intentOf = (row: PinRow, reason: string): Wire.ReceiptPointer => {
    const digest = canonicalJsonDigest({
      pinId: row.pin_id,
      reason,
      resourceId: row.resource_id,
      version: row.version,
      digest: row.digest,
    })
    const receipt: Wire.ReceiptPointer = {
      authorityId: 'agh.resources',
      receiptId: `release-${row.pin_id}`,
      digest,
    }
    if (!validateRuntime('ReceiptPointer', receipt).ok)
      throw new CatalogFault('incompatible', 'resources_pin_corrupt')
    return receipt
  }
  async function referenced(row: PinRow, context: CallContext) {
    const others = (
      db
        .prepare(`SELECT pin_id, status FROM resource_pin WHERE resource_id=? AND version=? AND digest=?`)
        .all(row.resource_id, row.version, row.digest) as Array<{ pin_id: string; status: string }>
    ).some((item) => item.pin_id !== row.pin_id && item.status !== 'released')
    if (others || row.package_state === 'uncertain') return true
    if (row.package_state !== 'bound') return false
    if (!packagePins) return true
    const active = await packagePins.active(context)
    if (!active.ok) return true
    return active.value.some((ref) => {
      if (ref.kind !== 'inline' || !ref.value || typeof ref.value !== 'object' || Array.isArray(ref.value))
        return true
      return (ref.value as { pinId?: unknown }).pinId === row.pin_id
    })
  }
  async function release(request: Wire.ResourcesReleaseRequest, context: CallContext) {
    const claim = request.retention
    if (claim.kind !== 'domain-record' || claim.authorityId !== 'agh.resources')
      throw new CatalogFault('conflict', 'resources_pin_mismatch')
    return exclusive(async () => {
      await settle(context)
      const row = pinById(claim.pinId)
      if (!row) throw new CatalogFault('invalid_input', 'resources_pin_unknown')
      if (
        row.resource_id !== claim.resourceId ||
        row.version !== claim.version ||
        row.digest !== claim.digest
      )
        throw new CatalogFault('conflict', 'resources_pin_mismatch')
      if (row.owner_id !== context.principalRef) throw new CatalogFault('denied', 'resources_pin_required')
      const prior = db.prepare('SELECT reason, digest FROM release_intent WHERE pin_id=?').get(row.pin_id) as
        | { reason: string; digest: string }
        | undefined
      if (prior && prior.reason !== request.reason)
        throw new CatalogFault('conflict', 'resources_release_conflict')
      const receipt = intentOf(row, request.reason)
      if (!prior)
        immediate(() => {
          db.prepare('INSERT INTO release_intent VALUES (?, ?, ?, ?)').run(
            row.pin_id,
            request.reason,
            receipt.receiptId,
            receipt.digest,
          )
        })
      const live = await referenced(row, context)
      const status = live ? 'release-pending' : 'released'
      immediate(() => {
        db.prepare(`UPDATE resource_pin SET status=? WHERE pin_id=?`).run(status, row.pin_id)
      })
      return { state: status, receipt }
    })
  }
  return {
    binding,
    implemented: ['list', 'describe', 'register', 'remove', 'retain', 'release'],
    incomplete: ['production-wiring'],
    async call(method, input, context) {
      try {
        guard(context)
        if (!Object.hasOwn(schemas, method)) return reject('incompatible', 'resources_unknown_method')
        const name = method as Method
        const parsed = validateRuntime(schemas[name], input)
        if (!parsed.ok) return reject('invalid_input', 'resources_input_schema')
        permission(name, null, context)
        if (name === 'retain')
          return { ok: true, value: await retain(parsed.value as Wire.ResourcesRetainRequest, context) }
        if (name === 'release')
          return { ok: true, value: await release(parsed.value as Wire.ResourcesReleaseRequest, context) }
        if (name === 'register') {
          const request = parsed.value as Wire.ResourcesRegisterRequest
          permission(name, request.descriptor, context)
          const row = { descriptor: request.descriptor, release: request.ownerReleaseSetId }
          available(row)
          const rev = change(() => {
            const old = db.prepare('SELECT id FROM catalog WHERE id=?').get(row.descriptor.id)
            if (old) {
              const prior = load(row.descriptor.id)
              if (prior.descriptor.version === row.descriptor.version) {
                if (canonicalJsonDigest(prior) !== canonicalJsonDigest(row))
                  throw new CatalogFault('conflict', 'resources_version_conflict')
                throw new CatalogFault('conflict', 'resources_duplicate_registration')
              }
            }
            db.prepare('INSERT OR REPLACE INTO catalog VALUES (?, ?)').run(
              row.descriptor.id,
              JSON.stringify(row),
            )
          })
          return { ok: true, value: { revision: rev } }
        }
        if (name === 'remove') {
          const request = parsed.value as Wire.ResourcesRemoveRequest
          const rev = change(() => {
            const row = load(request.id)
            permission(name, row.descriptor, context)
            if (request.expectedRevision !== revision())
              throw new CatalogFault('conflict', 'resources_revision_conflict')
            db.prepare('DELETE FROM catalog WHERE id=?').run(request.id)
          })
          return { ok: true, value: { revision: rev } }
        }
        if (name === 'describe') {
          const request = parsed.value as Wire.ResourcesDescribeRequest
          const row = load(request.resourceId)
          permission(name, row.descriptor, context)
          available(row)
          if (request.version !== null && row.descriptor.version !== request.version)
            throw new CatalogFault('conflict', 'resources_version_stale')
          const before = revision()
          await discover([row.descriptor], context)
          if (before !== revision()) throw new CatalogFault('conflict', 'resources_snapshot_stale')
          permission(name, row.descriptor, context)
          available(row)
          note([row.descriptor])
          return { ok: true, value: structuredClone(row.descriptor) }
        }
        const request = parsed.value as Wire.ResourcesListRequest
        if (request.limit < 1 || request.limit > 100) return reject('invalid_input', 'resources_limit')
        const collect = () => {
          const found: Wire.ResourceDescriptor[] = []
          for (const entry of db.prepare('SELECT id FROM catalog ORDER BY id').all()) {
            const row = load(String(entry.id)),
              descriptor = row.descriptor
            if (
              descriptor.kind !== request.kind ||
              (request.filter.namespace !== undefined && descriptor.namespace !== request.filter.namespace) ||
              (!request.filter.tags?.every((tag) => descriptor.tags.includes(tag)) &&
                request.filter.tags !== undefined)
            )
              continue
            try {
              permission(name, descriptor, context)
              available(row)
            } catch (error) {
              if (error instanceof CatalogFault) continue
              throw error
            }
            found.push(descriptor)
          }
          return found
        }
        const before = revision()
        let found = collect()
        const snapshot = canonicalJsonDigest({
          scope,
          revision: revision(),
          principal: context.principalRef,
          authorization: context.authorizationRef,
          request: { ...request, cursor: null },
          found,
        })
        let offset = 0
        if (request.cursor !== null) {
          try {
            const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString())
            if (
              cursor.snapshot !== snapshot ||
              !Number.isSafeInteger(cursor.offset) ||
              cursor.offset < 1 ||
              cursor.offset >= found.length
            )
              throw new Error()
            offset = cursor.offset
          } catch {
            return reject('conflict', 'resources_cursor_stale')
          }
        }
        await discover(found.slice(offset, offset + request.limit), context)
        permission(name, null, context)
        const after = collect()
        if (before !== revision() || canonicalJsonDigest(after) !== canonicalJsonDigest(found))
          throw new CatalogFault('conflict', 'resources_snapshot_stale')
        found = after
        const end = Math.min(found.length, offset + request.limit)
        note(found.slice(offset, end))
        return {
          ok: true,
          value: {
            items: structuredClone(found.slice(offset, end)),
            snapshot,
            nextCursor:
              end < found.length
                ? Buffer.from(JSON.stringify({ snapshot, offset: end })).toString('base64url')
                : null,
            complete: end === found.length,
          },
        }
      } catch (error) {
        if (error instanceof CatalogFault) return reject(error.code, error.detail)
        return reject('retryable', 'resources_dependency_unavailable')
      }
    },
    close() {
      if (!closed) {
        closed = true
        lifetime.abort()
        db.close()
      }
    },
  }
}

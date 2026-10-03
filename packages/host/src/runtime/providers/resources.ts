import { closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

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
  return {
    binding,
    implemented: ['list', 'describe', 'register', 'remove'],
    incomplete: ['durable-retain', 'durable-release', 'pin-gc-races', 'production-wiring'],
    async call(method, input, context) {
      try {
        guard(context)
        if (!Object.hasOwn(schemas, method)) return reject('incompatible', 'resources_unknown_method')
        const name = method as Method
        const parsed = validateRuntime(schemas[name], input)
        if (!parsed.ok) return reject('invalid_input', 'resources_input_schema')
        permission(name, null, context)
        if (name === 'retain' || name === 'release')
          return reject('incompatible', 'resources_pin_unavailable')
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

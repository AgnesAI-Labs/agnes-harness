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
  ResourceDescriptor,
  ResourcesDescribeRequest,
  ResourcesListRequest,
  ResourcesRegisterRequest,
  ResourcesRemoveRequest,
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
  async function execute(operation: string, argument: unknown, ctx: CallContext): Promise<unknown> {
    checkCall(ctx)
    const type = requestTypes.get(operation as QueryName)
    if (!type) fail('incompatible', 'resources_unknown_method')
    const decoded = decode(type, argument)
    if (!decoded.ok) fail('invalid_input', 'resources_input_schema')
    allow(operation, null, ctx)
    if (operation === 'retain' || operation === 'release') fail('incompatible', 'resources_pin_unavailable')
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
    implemented: ['list', 'describe', 'register', 'remove'],
    incomplete: ['durable-retain', 'durable-release', 'pin-gc-races', 'production-wiring'],
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

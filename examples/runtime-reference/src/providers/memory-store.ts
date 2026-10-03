import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'

export interface ReferenceAccess {
  scope: W.ScopeRef
  tenantRef: string
  identity(context: CallContext): W.AuthenticatedIdentity
  authorize(method: string, item: W.MemoryItem | null, context: CallContext): boolean
  sourceAvailable(source: W.PublicRef, trust: W.MemoryItem['trust'], context: CallContext): boolean
}
export class ReferenceRefusal extends Error {
  constructor(
    public code: W.RuntimeError['code'],
    public detailCode: string,
  ) {
    super(detailCode)
  }
}
export const failure = (
  code: W.RuntimeError['code'],
  detailCode: string,
): { ok: false; error: W.RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Reference memory request refused',
    diagnosticId: 'memory-retrieval',
    retryAdvice: { kind: 'never' },
  },
})
export const caught = (error: unknown, domain: string) =>
  error instanceof ReferenceRefusal
    ? failure(error.code, error.detailCode)
    : failure('retryable', domain + '_dependency_unavailable')
export function access(policy: ReferenceAccess, context: CallContext, unavailable: boolean): void {
  if (unavailable) throw new ReferenceRefusal('denied', 'provider_closed')
  if (
    context.signal.aborted ||
    !Number.isFinite(Date.parse(context.deadline)) ||
    Date.now() >= Date.parse(context.deadline)
  )
    throw new ReferenceRefusal('cancelled', 'request_cancelled')
  const supplied = context.scope,
    installed = policy.scope
  if (
    !('workspaceId' in supplied && 'workspaceId' in installed) ||
    supplied.workspaceId !== installed.workspaceId ||
    supplied.runtimeId !== installed.runtimeId ||
    supplied.installationId !== installed.installationId
  )
    throw new ReferenceRefusal('denied', 'workspace_denied')
  const authenticated = policy.identity(context)
  if (
    !validateRuntime('AuthenticatedIdentity', authenticated).ok ||
    authenticated.tenantRef !== policy.tenantRef ||
    authenticated.principalRef !== context.principalRef ||
    Date.now() >= Date.parse(authenticated.expiresAt)
  )
    throw new ReferenceRefusal('denied', 'tenant_denied')
}
export function visibility(
  policy: ReferenceAccess,
  operation: string,
  entry: W.MemoryItem | null,
  context: CallContext,
): boolean {
  if (policy.authorize(operation, structuredClone(entry), context) !== true) return false
  return (
    entry === null ||
    entry.sourceRefs.every(
      (source) => policy.sourceAvailable(structuredClone(source), entry.trust, context) === true,
    )
  )
}
export function pack(schema: W.SchemaRef, value: unknown): Outcome<W.DataRef> {
  const canonical = boundedCanonicalJson(value, { maxBytes: 16384, maxDepth: 32, maxMembers: 4096 })
  return canonical.ok
    ? {
        ok: true,
        value: {
          schema,
          kind: 'inline',
          digest: canonicalJsonDigest(canonical.value.json),
          bytes: canonical.value.bytes,
          value: canonical.value.json,
        },
      }
    : failure('quota', 'output_budget')
}
export function unpack(data: W.DataRef, schema: W.SchemaRef): Outcome<unknown> {
  if (data.kind === 'blob') return failure('incompatible', 'blob_reader_required')
  const encoded = pack(schema, data.value)
  if (
    !encoded.ok ||
    encoded.value.kind !== 'inline' ||
    canonicalJsonDigest(schema) !== canonicalJsonDigest(data.schema) ||
    data.bytes !== encoded.value.bytes ||
    data.digest !== encoded.value.digest
  )
    return failure('invalid_input', 'input_reference_invalid')
  return { ok: true, value: data.value }
}
/** Reference stores a single transactional snapshot, independently of the default relational layout. */
export function snapshotStore<T>(directory: string, name: string, policy: ReferenceAccess, initial: T) {
  mkdirSync(directory, { recursive: true, mode: 448 })
  const file = join(directory, name + '-reference.sqlite'),
    connection = new DatabaseSync(file)
  chmodSync(file, 384)
  connection.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshot (slot INTEGER PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL)',
  )
  const owner = canonicalJsonDigest({ scope: policy.scope, tenant: policy.tenantRef })
  connection.prepare('INSERT OR IGNORE INTO snapshot VALUES (0, ?, ?)').run(owner, JSON.stringify(initial))
  if (connection.prepare('SELECT owner FROM snapshot WHERE slot=0').get()?.owner !== owner) {
    connection.close()
    throw new Error(name + '_scope_mismatch')
  }
  const load = (): T =>
    JSON.parse(String(connection.prepare('SELECT value FROM snapshot WHERE slot=0').get()?.value)) as T
  return {
    load,
    update<R>(mutate: (state: T) => R): R {
      connection.exec('BEGIN IMMEDIATE')
      try {
        const state = load(),
          answer = mutate(state)
        connection.prepare('UPDATE snapshot SET value=? WHERE slot=0').run(JSON.stringify(state))
        connection.exec('COMMIT')
        return answer
      } catch (exception) {
        connection.exec('ROLLBACK')
        throw exception
      }
    },
    finish: () => connection.close(),
  }
}

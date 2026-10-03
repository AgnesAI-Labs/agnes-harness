import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface MemoryContractOptions {
  directory: string
  scope: Wire.ScopeRef
  tenantRef: string
  identity(context: CallContext): Wire.AuthenticatedIdentity
  authorize(method: string, item: Wire.MemoryItem | null, context: CallContext): boolean
  sourceAvailable(source: Wire.PublicRef, trust: Wire.MemoryItem['trust'], context: CallContext): boolean
}
export interface MemoryContractSubject extends ServiceProvider {
  binding: Wire.BindingRef
  call(method: string, input: unknown, context: CallContext, delivery?: string): Promise<Outcome<unknown>>
  pendingDeletions(): readonly Wire.DeletionReceipt[]
  acknowledgeDeletion(id: string): void
}
export const memoryScope: Wire.ScopeRef = {
  kind: 'workspace',
  installationId: 'fixture-installation',
  runtimeId: 'fixture-runtime',
  workspaceId: 'fixture-workspace',
}
export function memoryContext(id = 'remember', signal = new AbortController().signal): CallContext {
  return {
    scope: memoryScope,
    signal,
    principalRef: 'fixture-principal',
    authorizationRef: 'fixture-acl',
    bindingId: 'fixture-binding',
    invocationId: id,
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'fixture-trace',
  }
}
export function memoryData(schema: Wire.SchemaRef, value: Wire.JsonValue): Wire.DataRef {
  return {
    kind: 'inline',
    schema,
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
  }
}
export function memoryOptions(directory: string): MemoryContractOptions {
  return {
    directory,
    scope: memoryScope,
    tenantRef: 'fixture-tenant',
    identity: (context) => ({
      principalRef: context.principalRef,
      tenantRef: context.authorizationRef === 'other-tenant' ? 'other' : 'fixture-tenant',
      claims: memoryData(RuntimeMethodSchemaRefs['agh.memory'].get.input, {}),
      authRevision: 1,
      expiresAt: '2030-01-01T00:00:00Z',
      authKind: 'local',
      credentialKind: 'local',
      ownerClass: 'local-owner',
    }),
    authorize: (_method, _item, context) => context.principalRef === 'fixture-principal',
    sourceAvailable: (source) => source.kind === 'resource' && source.value.resourceId === 'fixture-source',
  }
}
export function memoryRequest(expiresAt: string | null = null): Wire.MemoryRememberRequest {
  return {
    expectedRevision: 0,
    items: [
      {
        contentRef: memoryData(
          { typeId: 'fixture/content@1', revision: 1, digest: canonicalJsonDigest('content-schema') },
          'alpha knowledge',
        ),
        sourceRefs: [
          {
            kind: 'resource',
            value: { resourceId: 'fixture-source', version: '1', digest: canonicalJsonDigest('source') },
          },
        ],
        trust: 'derived',
        labels: ['knowledge'],
        expiresAt,
      },
    ],
  }
}
export function insistMemory(value: unknown, description: string): asserts value {
  if (!value) throw new Error(description)
}
export function memoryValue<T>(name: keyof Wire.RuntimeWireTypes, outcome: Outcome<unknown>): T {
  insistMemory(outcome.ok, name + ' refused')
  const parsed = validateRuntime(name, outcome.value)
  insistMemory(parsed.ok, name + ' schema invalid')
  return parsed.value as T
}
export const memoryDetail = (result: Outcome<unknown>) => (result.ok ? 'ok' : result.error.detailCode)
export function memoryActionFrame(
  binding: Wire.BindingRef,
  method: 'remember' | 'forget' | 'searchRemote',
  value: Wire.JsonValue,
  actionId = 'remote-parent',
): Wire.ActionFrame {
  const { signal: _signal, ...context } = memoryContext(actionId)
  const schema =
    method === 'searchRemote'
      ? RuntimeMethodSchemaRefs['agh.retrieval'].searchRemote.input
      : RuntimeMethodSchemaRefs['agh.memory'][method].input
  const input = memoryData(schema, value)
  return {
    actionId,
    parentActionId: null,
    runId: 'fixture-run',
    bindingId: binding.bindingId,
    method,
    input,
    inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
    attemptId: 'fixture-attempt',
    attemptNumber: 1,
    invocationId: actionId,
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 'signals', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'receipts', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'frame',
    observedAt: new Date().toISOString(),
    context: { ...context, bindingId: binding.bindingId },
    actionTimebox: { defaultTimeoutMs: 10000, maxDeadline: context.deadline },
  }
}
export interface MemoryContractBinding {
  providerId: 'default' | 'reference'
  providerDigest: string
  command: string
  build: BuildIdentity
  create(options: MemoryContractOptions): MemoryContractSubject
  coldRead(
    directory: string,
    ids: readonly string[],
  ): Promise<{ result: Outcome<unknown>; pending: readonly Wire.DeletionReceipt[] }>
}
export async function exerciseMemory(binding: MemoryContractBinding, scenario: ScenarioName): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'memory-contract-')),
    options = memoryOptions(directory),
    subject = binding.create(options),
    context = memoryContext(),
    request = memoryRequest()
  try {
    insistMemory(subject.binding.providerId === `agh.${binding.providerId}/memory`, 'selected Memory')
    insistMemory((await subject.ready(context)).ok, 'ready Memory')
    const remembered = memoryValue<Wire.MemoryRememberResult>(
        'MemoryRememberResult',
        await subject.call('remember', request, context),
      ),
      ids = remembered.memoryRefs.map((ref) => ref.id)
    const handler = await subject.actions!.remember!.create({
      instanceId: 'fixture-instance',
      actionId: 'remember',
      runId: 'fixture-run',
      bindingId: subject.binding.bindingId,
      scope: context.scope,
      signal: context.signal,
    })
    insistMemory(handler.kind === 'leaf', 'remember leaf action')
    const frame = memoryActionFrame(subject.binding, 'remember', request, 'remember')
    const actionContext = {
      call: context,
      effects: {
        invoke: async () => {
          throw new Error('unexpected external effect')
        },
        stream: async () => {
          throw new Error('unexpected stream')
        },
        upload: async () => {
          throw new Error('unexpected upload')
        },
      },
      progress: async () => ({ ok: true as const, value: undefined }),
    }
    insistMemory(
      (await handler.execute(frame, actionContext)).outcome === 'succeeded',
      'public effect SPI delivery replay',
    )
    const reconciled = await handler.reconcile(frame, [], actionContext)
    insistMemory(
      reconciled.kind === 'resolved' && reconciled.result.outcome === 'succeeded',
      'durable delivery reconciliation',
    )
    insistMemory((await handler.drain(context.deadline, context)).ok, 'action drains independently')
    insistMemory(!(await handler.ready(context)).ok, 'drained action is unavailable')
    await handler.close('completed')
    insistMemory((await subject.ready(context)).ok, 'action drain keeps parent available')
    const get = () => subject.call('get', { ids, atRevision: null }, memoryContext('get'))
    const first = memoryValue<Wire.MemoryGetResult>('MemoryGetResult', await get())
    insistMemory(
      first.items.length === 1 &&
        first.items[0]?.sourceRefs.length === 1 &&
        first.items[0].provenance.producer.providerId === subject.binding.providerId,
      'authorized sourced Memory after action disposal',
    )
    const query = await subject.query!(
      {
        target: subject.binding,
        method: 'get',
        input: memoryData(RuntimeMethodSchemaRefs['agh.memory'].get.input, { ids, atRevision: null }),
      },
      context,
    )
    insistMemory(query.ok && query.value.kind === 'value', 'public query SPI')
    if (scenario === 'normal') {
      const replay = memoryValue<Wire.MemoryRememberResult>(
        'MemoryRememberResult',
        await subject.call('remember', request, context),
      )
      insistMemory(
        canonicalJsonDigest(replay) === canonicalJsonDigest(remembered),
        'delivery replay without revision increment',
      )
      const forget = { memoryIds: ids, reason: 'withdrawn', expectedRevision: 1 }
      const deleted = memoryValue<Wire.MemoryForgetResult>(
        'MemoryForgetResult',
        await subject.call('forget', forget, memoryContext('forget')),
      )
      insistMemory(
        deleted.deletionReceipt.watermark === 2 && subject.pendingDeletions().length === 1,
        'atomic tombstone outbox',
      )
      insistMemory(
        memoryValue<Wire.MemoryGetResult>('MemoryGetResult', await get()).items.length === 0,
        'deleted absent',
      )
      insistMemory(
        (await subject.call('forget', forget, memoryContext('forget'))).ok &&
          subject.pendingDeletions().length === 1,
        'repeat forget stable receipt',
      )
    } else if (scenario === 'deny') {
      insistMemory(
        memoryDetail(
          await subject.call(
            'get',
            { ids, atRevision: null },
            { ...context, authorizationRef: 'other-tenant' },
          ),
        ) === 'tenant_denied',
        'cross tenant',
      )
      insistMemory(
        memoryDetail(
          await subject.call('get', { ids, atRevision: null }, { ...context, principalRef: 'outsider' }),
        ) === 'memory_denied',
        'ACL deny',
      )
      insistMemory(
        memoryDetail(await subject.call('remember', { ...request, expectedRevision: 1 }, context)) ===
          'memory_delivery_conflict',
        'changed delivery',
      )
      insistMemory(
        memoryDetail(
          await subject.call(
            'forget',
            { memoryIds: ids, reason: 'stale', expectedRevision: 0 },
            memoryContext('stale'),
          ),
        ) === 'memory_revision_conflict',
        'revision CAS',
      )
      options.sourceAvailable = () => false
      insistMemory(
        memoryValue<Wire.MemoryGetResult>('MemoryGetResult', await get()).items.length === 0,
        'revoked source',
      )
      options.sourceAvailable = () => {
        throw new Error('source service failed')
      }
      insistMemory(
        memoryDetail(await get()) === 'memory_dependency_unavailable',
        'failure differs from empty',
      )
      options.sourceAvailable = () => true
      insistMemory(
        (
          await subject.call(
            'remember',
            { ...memoryRequest('2000-01-01T00:00:00Z'), expectedRevision: 1 },
            memoryContext('expired'),
          )
        ).ok,
        'TTL ingestion',
      )
      insistMemory(
        memoryValue<Wire.MemoryGetResult>(
          'MemoryGetResult',
          await subject.call('get', { ids: [], atRevision: null }, context),
        ).items.length === 1,
        'TTL excluded',
      )
    } else if (scenario === 'cancel') {
      const controller = new AbortController()
      controller.abort()
      insistMemory(
        memoryDetail(
          await subject.call(
            'forget',
            { memoryIds: ids, reason: 'cancelled', expectedRevision: 1 },
            memoryContext('cancel', controller.signal),
          ),
        ) === 'request_cancelled',
        'cancel before commit',
      )
      insistMemory(
        memoryValue<Wire.MemoryGetResult>('MemoryGetResult', await get()).revision === 1,
        'cancel preserves state',
      )
    } else if (scenario === 'recover') {
      const two = memoryValue<Wire.MemoryRememberResult>(
        'MemoryRememberResult',
        await subject.call('remember', { ...request, expectedRevision: 1 }, memoryContext('second')),
      )
      insistMemory(
        (
          await subject.call(
            'forget',
            { memoryIds: ids, reason: 'restart', expectedRevision: 2 },
            memoryContext('forget'),
          )
        ).ok,
        'persist pending delete',
      )
      await subject.close('shutdown')
      const cold = await binding.coldRead(directory, [...ids, ...two.memoryRefs.map((ref) => ref.id)])
      const restored = memoryValue<Wire.MemoryGetResult>('MemoryGetResult', cold.result)
      insistMemory(
        restored.revision === 3 &&
          restored.items.length === 1 &&
          restored.items[0]?.ref.id === two.memoryRefs[0]?.id &&
          cold.pending.length === 1,
        'new process restores live memory and deletion job',
      )
    } else if (scenario === 'dispose') {
      insistMemory((await subject.drain(context.deadline, context)).ok, 'drain')
      await subject.close('shutdown')
      await subject.close('shutdown')
      insistMemory(memoryDetail(await get()) === 'provider_closed', 'disposed reads fail')
      insistMemory(
        memoryDetail(await subject.call('remember', request, context)) === 'provider_closed',
        'disposed writes fail',
      )
    }
  } finally {
    await subject.close('shutdown')
    rmSync(directory, { recursive: true, force: true })
  }
}
export function registerMemoryContract(harness: ConformanceHarness, binding: MemoryContractBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.memory',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        await exerciseMemory(binding, scenario)
        return {
          id: `agh.memory/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'sourced-memory-domain',
          features: ['remember', 'get', 'forget', 'deletion-propagation'],
          build: binding.build,
          consumer: 'memory-contract-consumer',
          command: binding.command,
          status: 'passed',
          configDigest: canonicalJsonDigest(memoryScope),
          releaseSetDigest: canonicalJsonDigest('memory-fixture-release'),
          attachmentDigest: canonicalJsonDigest('memory-contract-v1'),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: 'effect',
            lifecycle:
              scenario === 'recover' || scenario === 'cancel' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}

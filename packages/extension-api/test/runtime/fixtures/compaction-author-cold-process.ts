import { readFileSync } from 'node:fs'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { type AlgorithmAdapterDefinition, runtimeAuthorSchemas } from '../../../src/runtime/authoring.js'
import { createAuthorSchema } from '../../../src/runtime/authoring-schema-core.js'
import { createCompactionAuthorMethods } from '../../../src/runtime/compaction-authoring.js'
import type * as L from '../../../src/runtime/public-api.js'
import { createTestServiceContainer } from '../../../testkit/runtime/harness.js'

// Author-wrapper fixture only. No State, history, receipt or domain authority is installed.
const binding: W.BindingRef = {
  bindingId: 'compaction',
  contract: 'agh.compaction',
  logicalName: 'default',
  providerId: 'fixture/compaction-cold',
}
const scope: W.ScopeRef = {
  kind: 'session',
  installationId: 'i',
  runtimeId: 'rt',
  workspaceId: 'w',
  sessionId: 's',
}
const schemas = RuntimeMethodSchemaRefs['agh.compaction']
const codec: W.StateCodecRef = {
  namespace: 'fixture/compaction-cold',
  codecVersion: '1',
  schema: runtimeAuthorSchemas.StandardToolOutput.ref,
}
function data(name: keyof W.RuntimeWireTypes, schema: W.SchemaRef, value: unknown): W.DataRef {
  const result = createAuthorSchema(schema, (input) => validateRuntime(name, input)).encode(value as never)
  if (!result.ok) throw result.error
  return result.value
}
function stateData(stage: string, inputDigest: W.Digest): W.DataRef {
  const result = runtimeAuthorSchemas.StandardToolOutput.encode({
    content: [],
    structured: { stage, inputDigest },
  })
  if (!result.ok) throw result.error
  return result.value
}
function fault(detailCode: string, code: W.RuntimeError['code'] = 'incompatible'): W.RuntimeError {
  return {
    code,
    detailCode,
    message: 'Compaction cold fixture refused',
    diagnosticId: 'compaction-cold-fixture',
    retryAdvice: { kind: 'never' },
  }
}
const plan: W.CompactionPlan = {
  planId: 'fixture-plan',
  baseRevision: 1,
  inputDigest: canonicalJsonDigest([]),
  decision: 'noop',
  reasonCodes: ['fixture-empty-view'],
  algorithm: binding,
  privatePlan: stateData('plan', canonicalJsonDigest([])),
  outputCodec: codec.schema,
  preservedRefs: [],
  sourceRanges: [],
}
const lifecycle: L.ProviderLifecycle = {
  ready: async () => ({ ok: true, value: undefined }),
  health: async () => ({ ok: true, value: { status: 'ready', diagnosticIds: [] } }),
  drain: async () => ({
    ok: true,
    value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
  }),
  close: async () => {},
}
let forbiddenCalls = 0
const unavailable = (): never => {
  forbiddenCalls++
  throw new Error('Fixture has no authorized read or effect ports')
}
const ports: L.LoopReadPorts = {
  query: async () => unavailable(),
  compute: async () => unavailable(),
  resolveData: async () => unavailable(),
  prepare: unavailable,
}
function action(): L.ActionProviderFactory {
  return {
    kind: 'composite',
    recovery: 'R2',
    stateCodec: codec,
    async create() {
      return {
        ...lifecycle,
        kind: 'composite',
        async start(frame) {
          return {
            expectedProviderRevision: frame.providerRevision,
            continuation: {
              namespace: codec.namespace,
              codecVersion: codec.codecVersion,
              data: stateData('captured', frame.inputDigest),
              provenance: {
                sourceRefs: ['fixture-locked-input'],
                producer: binding,
                trustLabels: ['derived'],
              },
              createdAt: frame.observedAt,
              references: [],
            },
            consumeSignals: [],
            children: [],
            next: { kind: 'continue' },
          }
        },
        async resume(frame) {
          const continuation = frame.continuation
          if (!continuation) throw fault('fixture_state_unavailable')
          const retained = continuation.data
          if (retained.kind !== 'inline') throw fault('fixture_state_unavailable')
          const state = runtimeAuthorSchemas.StandardToolOutput.parse(retained.value)
          if (!state.ok) throw state.error
          const structured = state.value.structured
          if (
            !structured ||
            typeof structured !== 'object' ||
            Array.isArray(structured) ||
            structured.stage !== 'captured' ||
            structured.inputDigest !== frame.inputDigest
          )
            throw fault('fixture_original_input_mismatch', 'denied')
          return {
            expectedProviderRevision: frame.providerRevision,
            continuation,
            consumeSignals: [],
            children: [],
            next: { kind: 'fail', error: fault('compaction_source_owner_unavailable') },
          }
        },
      }
    },
  }
}
const definition: AlgorithmAdapterDefinition<'agh.compaction'> = {
  id: 'compaction-cold',
  contract: 'agh.compaction',
  requires: [],
  permissions: [],
  stateCodecs: [codec],
  make: () => ({
    plan: async () => ({ ok: false, error: fault('compaction_source_owner_unavailable') }),
    expand: async () => ({ ok: false, error: fault('compaction_history_owner_unavailable') }),
    execute: action(),
    apply: action(),
  }),
}
function initialFrame(): W.ActionFrame {
  const input = data('CompactionExecuteRequest', schemas.execute.input, { plan, expectedRevision: 1 })
  const context: W.CallContextWire = {
    scope,
    bindingId: binding.bindingId,
    invocationId: 'first',
    principalRef: 'fixture-principal',
    authorizationRef: 'fixture-auth',
    traceRef: 'fixture-trace',
    deadline: '2099-01-01T00:00:00Z',
  }
  return {
    actionId: 'fixture-action',
    parentActionId: null,
    runId: 'r',
    bindingId: binding.bindingId,
    method: 'execute',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : '',
    attemptId: 'fixture-attempt',
    attemptNumber: 1,
    invocationId: context.invocationId,
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], nextCursor: null, complete: true, snapshot: 'fixture-snapshot' },
    receipts: { items: [], nextCursor: null, complete: true, snapshot: 'fixture-snapshot' },
    signalHighWater: 0,
    snapshot: 'fixture-snapshot',
    observedAt: '2026-10-05T00:00:00Z',
    context,
    actionTimebox: { defaultTimeoutMs: 1000, maxDeadline: context.deadline },
  }
}
async function main() {
  const [mode, path, alteration] = process.argv.slice(2)
  if (!mode || (mode !== 'start' && mode !== 'resume')) throw new Error('Unknown fixture mode')
  if (mode === 'resume' && !path) throw new Error('Snapshot path required')
  const frame: W.ActionFrame =
    mode === 'start' ? initialFrame() : JSON.parse(readFileSync(path ?? '', 'utf8'))
  if (mode === 'resume') {
    frame.invocationId = 'restored'
    frame.context.invocationId = frame.invocationId
  }
  if (alteration === 'codec' && frame.continuation) frame.continuation.codecVersion = 'foreign'
  if (alteration === 'schema' && frame.continuation)
    frame.continuation.data = data('JsonValue', codec.schema, { wrong: 'state' })
  if (alteration === 'input') {
    frame.input = data('CompactionExecuteRequest', schemas.execute.input, {
      plan: { ...plan, reasonCodes: ['changed-input'] },
      expectedRevision: 1,
    })
    frame.inputDigest = frame.input.kind === 'inline' ? frame.input.digest : ''
  }
  const signal = new AbortController().signal
  const call = { ...frame.context, signal }
  const adapter = await createCompactionAuthorMethods(definition, {
    binding,
    context: { bindingId: binding.bindingId, instanceId: 'fixture-instance', scope, signal },
    dependencies: createTestServiceContainer().dependencies,
    config: null,
  })
  const ready = await adapter.ready(call)
  if (!ready.ok) throw ready.error
  const child = await adapter.methods.execute.create({
    instanceId: 'fixture-child',
    actionId: frame.actionId,
    runId: frame.runId,
    bindingId: binding.bindingId,
    scope,
    signal,
  })
  if (child.kind !== 'composite') throw new Error('Composite fixture required')
  const childReady = await child.ready(call)
  if (!childReady.ok) throw childReady.error
  try {
    const phase = alteration === 'start' ? 'start' : mode
    const transition = await child[phase](frame, ports)
    const output = { pid: process.pid, frame, transition, forbiddenCalls }
    if (mode === 'start') {
      process.stdout.write(`${JSON.stringify(output)}\n`)
      setInterval(() => {}, 1000)
      return
    }
    await child.close('completed')
    const drain = await adapter.drain(call.deadline, call)
    await adapter.close('completed')
    process.stdout.write(`${JSON.stringify({ ...output, drain })}\n`)
  } catch (error) {
    await child.close('faulted')
    await adapter.close('faulted')
    const checked = validateRuntime('RuntimeError', error)
    if (!checked.ok) throw error
    process.stdout.write(`${JSON.stringify({ pid: process.pid, error: checked.value, forbiddenCalls })}\n`)
  }
}
await main()

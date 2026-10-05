import type { AlgorithmAdapterDefinition, LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import { adaptProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import {
  canonical,
  copy,
  DagFault,
  type DagState,
  demand,
  digest,
  equal,
  inline,
  referenceDagCodec,
  unwrap,
} from './dag-state.js'

export { referenceDagCodec } from './dag-state.js'
export interface ReferenceDagNode {
  id: string
  after: string[]
  join: 'any' | 'all'
  action: W.ActionSpec
}
export interface ReferenceDagDefinition {
  nodes: ReferenceDagNode[]
  output: W.DataRef
  references: W.RetentionRef[]
}
const supervisorRequirement: W.ServiceRequirement = {
  contract: 'agh.supervisor',
  major: 1,
  logicalName: 'default',
  scope: 'run',
  optional: false,
  features: [],
}
function graphDefinition(input: ReferenceDagDefinition) {
  const graph = copy(input)
  demand(Object.keys(graph).sort().join(',') === 'nodes,output,references', 'dag_graph_shape')
  demand(Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.nodes.length <= 32, 'dag_graph_limit')
  demand(
    validateRuntime('DataRef', graph.output).ok &&
      Array.isArray(graph.references) &&
      graph.references.every((ref) => validateRuntime('RetentionRef', ref).ok),
    'dag_output_invalid',
  )
  const ids = new Set<string>(),
    keys = new Set<string>()
  for (const node of graph.nodes) {
    demand(
      Object.keys(node).sort().join(',') === 'action,after,id,join' && /^[a-z][a-z0-9-]{0,63}$/.test(node.id),
      'dag_node_invalid',
    )
    demand(
      !ids.has(node.id) &&
        Array.isArray(node.after) &&
        new Set(node.after).size === node.after.length &&
        ['any', 'all'].includes(node.join),
      'dag_node_invalid',
    )
    demand(
      validateRuntime('ActionSpec', node.action).ok &&
        node.action.obligation === 'mandatory' &&
        node.action.dependencies.length === 0 &&
        !node.action.detachedOwner,
      'dag_action_unsupported',
    )
    demand(node.action.key === `dag/${node.id}` && !keys.has(node.action.key), 'dag_action_key')
    ids.add(node.id)
    keys.add(node.action.key)
  }
  const visited = new Set<string>()
  while (visited.size < graph.nodes.length) {
    const ready = graph.nodes.filter(
      (node) => !visited.has(node.id) && node.after.every((id) => visited.has(id)),
    )
    demand(ready.length, 'dag_cycle_or_missing_node')
    for (const node of ready) visited.add(node.id)
  }
  return graph
}

/** Fixed, bounded DAG algorithm through the public author declaration. No effect execution or State ownership. */
export function createReferenceDagLoop(input: ReferenceDagDefinition, binding: W.BindingRef) {
  const graph = graphDefinition(input)
  demand(validateRuntime('BindingRef', binding).ok && binding.contract === 'agh.loop', 'dag_binding_invalid')
  const producer = copy(binding)
  const requirements = [supervisorRequirement]
  for (const node of graph.nodes) {
    const target = node.action.target
    if (
      !requirements.some(
        (item) => item.contract === target.contract && item.logicalName === target.logicalName,
      )
    )
      requirements.push({
        contract: target.contract,
        logicalName: target.logicalName,
        major: 1,
        scope: 'run',
        optional: false,
        features: [],
      })
  }
  const definition: AlgorithmAdapterDefinition<'agh.loop'> = {
    id: 'reference-dag-loop',
    contract: 'agh.loop',
    requires: requirements,
    permissions: [],
    stateCodecs: [referenceDagCodec],
    make(_config, dependencies, factory) {
      demand(factory.scope.kind === 'run' && factory.bindingId === producer.bindingId, 'dag_scope_invalid')
      const scope = copy(factory.scope),
        bindingId = factory.bindingId,
        signal = factory.signal
      const selected = requirements.map((requirement) => copy(unwrap(dependencies.get(requirement)).binding))
      const candidate = selected[0]
      demand(
        candidate && candidate.contract === 'agh.supervisor' && candidate.logicalName === 'default',
        'dag_supervisor_missing',
      )
      const supervisor = candidate
      for (const node of graph.nodes)
        demand(
          selected.some((binding) => equal(binding, node.action.target)),
          'dag_target_changed',
          'conflict',
        )
      async function run(
        supplied: W.RunFrame,
        ports: LoopReadPorts,
        starting: boolean,
      ): Promise<W.LoopTransition> {
        // Snapshot all caller-owned input before the first asynchronous boundary.
        const frame = copy(supplied)
        let state: DagState = { identity: digest({ graph, scope, bindingId }), issued: [] }
        function current() {
          demand(!signal.aborted && frame.reason !== 'cancel', 'dag_cancelled', 'cancelled')
          demand(Date.parse(frame.context.deadline) > Date.now(), 'dag_invocation_expired', 'timeout')
        }
        async function readOperation<T>(operation: () => Promise<Outcome<T>>): Promise<T> {
          current()
          let timer: ReturnType<typeof setTimeout> | undefined
          let abort = () => {}
          const stopped = new Promise<never>((_, reject) => {
            abort = () => reject(new DagFault('dag_cancelled', 'cancelled'))
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
            timer = setTimeout(
              () => reject(new DagFault('dag_invocation_expired', 'timeout')),
              Math.min(2_147_483_647, Math.max(0, Date.parse(frame.context.deadline) - Date.now())),
            )
          })
          try {
            const value = unwrap(await Promise.race([operation(), stopped]))
            current()
            return value
          } finally {
            signal.removeEventListener('abort', abort)
            clearTimeout(timer)
          }
        }
        async function read(ref: W.DataRef, schema = ref.schema) {
          demand(validateRuntime('DataRef', ref).ok && equal(ref.schema, schema), 'dag_data_schema')
          current()
          const body = canonical(await readOperation(() => ports.resolveData(copy(ref))))
          const identity = ref.kind === 'inline' ? ref : ref.blob
          demand(body.bytes === identity.bytes && digest(body.json) === identity.digest, 'dag_data_integrity')
          return body.json
        }
        function references() {
          return [...graph.references, ...state.issued.flatMap((action) => action.references)]
        }
        function envelope(): W.VersionedState {
          return {
            namespace: referenceDagCodec.namespace,
            codecVersion: referenceDagCodec.codecVersion,
            data: inline(referenceDagCodec.schema, state),
            provenance: { producer, sourceRefs: [], trustLabels: [] },
            createdAt: frame.observedAt,
            references: references(),
          }
        }
        function transition(next: W.NextStep, actions: W.PreparedAction[] = []): W.LoopTransition {
          current()
          const result = {
            expectedRevision: frame.revision,
            continuation: envelope(),
            consumeSignals: [],
            actions,
            next,
          }
          demand(validateRuntime('LoopTransition', result).ok, 'dag_transition_invalid')
          return copy(result)
        }
        try {
          demand(
            validateRuntime('RunFrame', frame).ok &&
              frame.bindingId === bindingId &&
              frame.context.bindingId === bindingId &&
              equal(frame.context.scope, scope) &&
              frame.runId === scope.runId &&
              frame.sessionId === scope.sessionId &&
              frame.workspaceId === scope.workspaceId &&
              frame.context.invocationId === frame.invocationId,
            'dag_frame_identity',
            'denied',
          )
          demand(
            frame.conversation === null && frame.signals.complete && frame.signals.items.length === 0,
            'dag_frame_unsupported',
            'incompatible',
          )
          demand(
            starting
              ? frame.reason === 'start' && frame.revision === 0 && frame.continuation === null
              : frame.reason !== 'start' && frame.continuation !== null,
            'dag_phase_invalid',
          )
          current()
          await read(frame.input)
          state.identity = digest({
            graph,
            scope,
            bindingId,
            input: frame.input,
            parameters: frame.sessionParameters,
            supervisor,
          })
          if (!starting) {
            const outer = frame.continuation
            demand(
              outer &&
                outer.namespace === referenceDagCodec.namespace &&
                outer.codecVersion === referenceDagCodec.codecVersion &&
                equal(outer.provenance.producer, producer),
              'dag_codec_mismatch',
              'incompatible',
            )
            const saved = (await read(outer.data, referenceDagCodec.schema)) as unknown as DagState
            demand(
              saved &&
                Object.keys(saved).sort().join(',') === 'identity,issued' &&
                saved.identity === state.identity &&
                Array.isArray(saved.issued) &&
                saved.issued.length <= graph.nodes.length,
              'dag_state_identity',
              'conflict',
            )
            const keys = new Set<string>()
            for (const action of saved.issued) {
              current()
              demand(validateRuntime('PreparedAction', action).ok, 'dag_saved_action_invalid')
              const node = graph.nodes.find((node) => node.action.key === action.key)
              const { intentFingerprint: _fingerprint, ...spec } = action
              demand(
                node && equal(spec, node.action) && !keys.has(action.key),
                'dag_saved_action_changed',
                'conflict',
              )
              const prepared = unwrap(ports.prepare(copy(spec)))
              demand(equal(prepared, action), 'dag_preparation_changed', 'conflict')
              keys.add(action.key)
            }
            state = copy(saved)
            demand(equal(outer.references, references()), 'dag_retention_changed')
          }
          const succeeded = new Set<string>(),
            pending: { key: string; unknown: boolean }[] = []
          for (const action of state.issued) {
            current()
            const refs = RuntimeMethodSchemaRefs['agh.supervisor'].actionReceipt
            const reply = await readOperation(() =>
              ports.query({
                target: copy(supervisor),
                method: 'actionReceipt',
                snapshot: frame.snapshot,
                input: inline(refs.input, { action: { localKey: action.key } }),
              }),
            )
            demand(
              reply.kind === 'value' && reply.snapshot === frame.snapshot,
              'dag_receipt_snapshot',
              'conflict',
            )
            const decoded = validateRuntime(
              'SupervisorActionReceiptResult',
              await read(reply.output, refs.output),
            )
            demand(decoded.ok, 'dag_receipt_invalid')
            const result = decoded.value
            demand(result.actionId !== null, 'dag_committed_action_absent', 'conflict')
            if (result.visibility !== 'ready') {
              demand(result.receipt === null, 'dag_pending_receipt_invalid')
              pending.push({ key: action.key, unknown: false })
              continue
            }
            const receipt = result.receipt
            demand(
              receipt &&
                receipt.visibility === 'ready' &&
                receipt.actionId === result.actionId &&
                receipt.bindingId === action.target.bindingId &&
                receipt.inputDigest === digest(action.input),
              'dag_receipt_identity',
              'denied',
            )
            if (receipt.outcome === 'unknown_effect') {
              pending.push({ key: action.key, unknown: true })
              continue
            }
            demand(
              receipt.outcome === 'succeeded',
              'dag_action_failed',
              receipt.outcome === 'cancelled' ? 'cancelled' : 'internal',
            )
            demand(receipt.result, 'dag_result_missing')
            await read(receipt.result, action.resultSchema)
            succeeded.add(action.key)
          }
          const actions: W.PreparedAction[] = []
          if (!pending.some((item) => item.unknown)) {
            for (const node of graph.nodes) {
              if (state.issued.some((action) => action.key === node.action.key)) continue
              const ready =
                node.after.length === 0 ||
                (node.join === 'all'
                  ? node.after.every((id) => succeeded.has(`dag/${id}`))
                  : node.after.some((id) => succeeded.has(`dag/${id}`)))
              if (!ready) continue
              demand(
                Date.parse(node.action.deadline) > Date.now() &&
                  Date.parse(node.action.deadline) <= Date.parse(frame.actionTimebox.maxDeadline),
                'dag_action_deadline',
                'timeout',
              )
              await read(node.action.input)
              current()
              const prepared = copy(unwrap(ports.prepare(copy(node.action))))
              demand(validateRuntime('PreparedAction', prepared).ok, 'dag_prepared_invalid')
              const { intentFingerprint: _fingerprint, ...spec } = prepared
              demand(equal(spec, node.action), 'dag_prepare_substituted', 'denied')
              state.issued.push(prepared)
              actions.push(prepared)
              pending.push({ key: prepared.key, unknown: false })
            }
          }
          if (succeeded.size === graph.nodes.length) {
            await read(graph.output)
            return transition({ kind: 'complete', output: graph.output, references: graph.references })
          }
          demand(pending.length > 0, 'dag_stalled', 'conflict')
          return transition(
            {
              kind: 'wait',
              condition: {
                anyOf: pending.map((item) => ({
                  kind: 'actions',
                  mode: 'all',
                  actions: [{ localKey: item.key }],
                  readyWhen: item.unknown ? 'resolved' : 'receipt',
                })),
              },
            },
            actions,
          )
        } catch (error) {
          // A failed transition publishes no new intents, even if earlier preparation succeeded.
          state = { identity: digest({ graph, scope, bindingId }), issued: [] }
          return copy({
            expectedRevision: frame.revision,
            continuation: frame.continuation ?? envelope(),
            consumeSignals: [],
            actions: [],
            next: {
              kind: 'fail',
              error:
                error instanceof DagFault
                  ? error.error
                  : new DagFault('dag_dependency_unavailable', 'internal').error,
            },
          })
        }
      }
      return {
        start: (frame, ports) => run(frame, ports, true),
        resume: (frame, ports) => run(frame, ports, false),
      }
    },
  }
  return adaptProvider(definition)
}

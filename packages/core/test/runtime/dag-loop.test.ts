import type {
  AlgorithmAdapterDefinition,
  AuthorProviderDeclaration,
  LoopReadPorts,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { contextInline } from '../../../extension-api/testkit/runtime/contracts/context.js'
import type { LoopContractFixture } from '../../../extension-api/testkit/runtime/contracts/loop.js'

interface Graph {
  nodes: { id: string; after: string[]; join: 'any' | 'all'; action: W.ActionSpec }[]
  output: W.DataRef
  references: W.RetentionRef[]
}
type Fixture = LoopContractFixture & {
  bindings: Record<string, W.BindingRef>
  receipts: Map<string, W.ActionResultView>
}
async function open(join: 'any' | 'all' = 'all') {
  const { openLoopFixture } = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-conformance.ts', import.meta.url).href
  )) as { openLoopFixture(): Promise<Fixture> }
  const { createReferenceDagLoop } = (await import(
    new URL('../../../../examples/runtime-reference/src/providers/loop.ts', import.meta.url).href
  )) as {
    createReferenceDagLoop(
      graph: Graph,
      binding: W.BindingRef,
    ): AuthorProviderDeclaration<AlgorithmAdapterDefinition<'agh.loop'>>
  }
  const f = await openLoopFixture()
  const candidate = f.bindings.tools
  if (!candidate) throw new Error('Fixture target absent')
  const target = candidate
  const graph: Graph = {
    nodes: ['left', 'right', 'join'].map((id) => ({
      id,
      after: id === 'join' ? ['left', 'right'] : [],
      join,
      action: {
        key: `dag/${id}`,
        target,
        method: 'call',
        input: f.frame.input,
        dependencies: [],
        retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
        obligation: 'mandatory',
        deadline: f.frame.context.deadline,
        resultSchema: f.frame.input.schema,
        references: [],
      },
    })),
    output: f.frame.input,
    references: [],
  }
  const ownBinding = { ...required(f.bindings.loop), providerId: 'fixture/independent-dag' }
  const create = (graph: Graph) => createReferenceDagLoop(graph, ownBinding)
  const declaration = create(graph)
  const provider = await declaration.definition.make({}, f.dependencies, f.factoryContext)
  function succeed(action: W.PreparedAction, outcome: W.ActionResultView['outcome'] = 'succeeded') {
    const receipt: W.ActionResultView = {
      receiptId: `receipt-${action.key}`,
      sourceReceiptId: `receipt-${action.key}`,
      viewId: `view-${action.key}`,
      actionId: `action-${action.key}`,
      attemptId: `attempt-${action.key}`,
      bindingId: action.target.bindingId,
      // Match the State Action receipt producer's digest of the complete input DataRef.
      inputDigest: canonicalJsonDigest(action.input),
      outcome,
      result: graph.output,
      externalRequests: [],
      usageRefs: [],
      references: [],
      provenance: { producer: target, sourceRefs: [], trustLabels: [] },
      completedAt: f.frame.observedAt,
      visibility: 'ready',
      hookResultSetRef: null,
    }
    expect(validateRuntime('ActionResultView', receipt).ok).toBe(true)
    f.receipts.set(action.key, receipt)
    return receipt
  }
  return { ...f, graph, provider, createReferenceDagLoop: create, declaration, succeed }
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Required fixture value absent')
  return value
}
function fail(result: W.LoopTransition, detail: string) {
  expect(result.actions).toEqual([])
  expect(result.next.kind).toBe('fail')
  if (result.next.kind === 'fail') expect(result.next.error.detailCode).toBe(detail)
}
function action(transition: W.LoopTransition, key: string) {
  const found = transition.actions.find((action) => action.key === `dag/${key}`)
  if (!found) throw new Error(`Missing action ${key}: ${JSON.stringify(transition.next)}`)
  return found
}
describe('independent bounded DAG author algorithm through public Loop SPI', () => {
  it.each(['all', 'any'] as const)(
    'joins %s and drains every mandatory branch before completion',
    async (join) => {
      const f = await open(join)
      try {
        const first = await f.provider.start(f.frame, f.ports)
        expect(first.actions.map((action) => action.key)).toEqual(['dag/left', 'dag/right'])
        expect(validateRuntime('LoopTransition', first).ok).toBe(true)
        const frame = f.nextFrame(first)
        const restored = await f.declaration.definition.make({}, f.dependencies, f.factoryContext)
        expect((await restored.resume(frame, f.ports)).actions).toEqual([])
        f.succeed(action(first, 'left'))
        const partial = await restored.resume(frame, f.ports)
        expect(partial.actions.map((action) => action.key)).toEqual(join === 'any' ? ['dag/join'] : [])
        let joined = partial
        if (join === 'all') {
          f.succeed(action(first, 'right'))
          joined = await restored.resume(frame, f.ports)
        }
        f.succeed(action(joined, 'join'))
        const finalFrame = f.nextFrame(joined)
        const waiting = await restored.resume(finalFrame, f.ports)
        if (join === 'any') {
          expect(waiting.next.kind).toBe('wait')
          expect(waiting.actions).toEqual([])
          f.succeed(action(first, 'right'))
        }
        expect((await restored.resume(finalFrame, f.ports)).next).toEqual({
          kind: 'complete',
          output: f.graph.output,
          references: [],
        })
      } finally {
        await f.close()
      }
    },
  )
  it('unknown effects block further scheduling until resolved without resending the action', async () => {
    const f = await open('any')
    try {
      const first = await f.provider.start(f.frame, f.ports)
      f.succeed(action(first, 'left'))
      f.succeed(action(first, 'right'), 'unknown_effect')
      const frame = f.nextFrame(first)
      const waiting = await f.provider.resume(frame, f.ports)
      expect(waiting.actions).toEqual([])
      expect(waiting.next).toEqual({
        kind: 'wait',
        condition: {
          anyOf: [
            { kind: 'actions', mode: 'all', actions: [{ localKey: 'dag/right' }], readyWhen: 'resolved' },
          ],
        },
      })
      f.succeed(action(first, 'right'))
      expect((await f.provider.resume(frame, f.ports)).actions.map((action) => action.key)).toEqual([
        'dag/join',
      ])
    } finally {
      await f.close()
    }
  })
  it.each(['failed', 'cancelled'] as const)(
    'does not schedule past a %s mandatory branch',
    async (outcome) => {
      const f = await open('any')
      try {
        const first = await f.provider.start(f.frame, f.ports)
        f.succeed(action(first, 'left'))
        f.succeed(action(first, 'right'), outcome)
        fail(await f.provider.resume(f.nextFrame(first), f.ports), 'dag_action_failed')
      } finally {
        await f.close()
      }
    },
  )
  it('rejects cycles, missing predecessors, unstable keys and detached actions', async () => {
    const f = await open()
    try {
      for (const mutate of [
        (graph: Graph) => {
          required(graph.nodes[0]).after = ['join']
        },
        (graph: Graph) => {
          required(graph.nodes[0]).after = ['absent']
        },
        (graph: Graph) => {
          required(graph.nodes[0]).action.key = 'unstable'
        },
        (graph: Graph) => {
          required(graph.nodes[0]).action.obligation = 'detached'
        },
      ]) {
        const graph = structuredClone(f.graph)
        mutate(graph)
        expect(() => f.createReferenceDagLoop(graph)).toThrow()
      }
    } finally {
      await f.close()
    }
  })
  it('captures its graph and frame before asynchronous input resolution', async () => {
    const f = await open()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const ports: LoopReadPorts = {
        ...f.ports,
        async resolveData(ref) {
          await gate
          return f.ports.resolveData(ref)
        },
      }
      const frame = structuredClone(f.frame)
      const running = f.provider.start(frame, ports)
      frame.runId = 'changed'
      required(f.graph.nodes[0]).action.key = 'changed'
      release()
      expect((await running).actions.map((action) => action.key)).toEqual(['dag/left', 'dag/right'])
    } finally {
      await f.close()
    }
  })
  it('aborts a blocked input read and does not emit prepared actions', async () => {
    const f = await open()
    try {
      const running = f.provider.start(f.frame, { ...f.ports, resolveData: () => new Promise(() => {}) })
      f.cancel()
      fail(await running, 'dag_cancelled')
    } finally {
      await f.close()
    }
  })
  it('rejects current authorization revocation', async () => {
    const f = await open()
    try {
      f.revoke()
      fail(await f.provider.start(f.frame, f.ports), 'loop_fixture_revoked')
    } finally {
      await f.close()
    }
  })
  it('bounds a blocked read by the invocation deadline', async () => {
    vi.useFakeTimers()
    const f = await open()
    try {
      const frame = structuredClone(f.frame)
      frame.context.deadline = new Date(Date.now() + 50).toISOString()
      const running = f.provider.start(frame, { ...f.ports, resolveData: () => new Promise(() => {}) })
      await vi.advanceTimersByTimeAsync(51)
      fail(await running, 'dag_invocation_expired')
    } finally {
      await f.close()
      vi.useRealTimers()
    }
  })
  it('rejects modified content and schema while resolving even inline references', async () => {
    const f = await open()
    try {
      fail(
        await f.provider.start(f.frame, {
          ...f.ports,
          async resolveData() {
            return { ok: true, value: 'substituted' }
          },
        }),
        'dag_data_integrity',
      )
      const first = await f.provider.start(f.frame, f.ports)
      const frame = f.nextFrame(first)
      required(frame.continuation).data.schema.digest = '0'.repeat(64)
      fail(await f.provider.resume(frame, f.ports), 'dag_data_schema')
    } finally {
      await f.close()
    }
  })
  it('does not retain unissued intents after a later branch refuses preparation', async () => {
    const f = await open()
    try {
      const result = await f.provider.start(f.frame, {
        ...f.ports,
        prepare(spec) {
          if (spec.key === 'dag/right')
            return {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'branch_denied',
                message: 'Denied',
                diagnosticId: 'fixture',
                retryAdvice: { kind: 'never' },
              },
            }
          return f.ports.prepare(spec)
        },
      })
      fail(result, 'branch_denied')
      expect(validateRuntime('LoopTransition', result).ok).toBe(true)
      expect(result.continuation.data.kind === 'inline' && result.continuation.data.value).toMatchObject({
        issued: [],
      })
    } finally {
      await f.close()
    }
  })
  it('isolates failed output provenance from the next invocation', async () => {
    const f = await open()
    try {
      const failed = await f.provider.start(f.frame, {
        ...f.ports,
        prepare() {
          return {
            ok: false,
            error: {
              code: 'denied',
              detailCode: 'prepare_denied',
              message: 'Denied',
              diagnosticId: 'fixture',
              retryAdvice: { kind: 'never' },
            },
          }
        },
      })
      fail(failed, 'prepare_denied')
      failed.continuation.provenance.producer.providerId = 'forged/provider'
      const next = await f.provider.start(f.frame, f.ports)
      expect(next.next.kind).toBe('wait')
      expect(next.continuation.provenance.producer.providerId).toBe('fixture/independent-dag')
    } finally {
      await f.close()
    }
  })
  it('requests the exact frame snapshot for every authoritative receipt query', async () => {
    const f = await open()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const frame = f.nextFrame(first)
      const snapshots: (string | undefined)[] = []
      const result = await f.provider.resume(frame, {
        ...f.ports,
        async query(request) {
          snapshots.push(request.snapshot)
          return f.ports.query(request)
        },
      })
      expect(result.next.kind).toBe('wait')
      expect(snapshots).toEqual([frame.snapshot, frame.snapshot])
    } finally {
      await f.close()
    }
  })
  it.each(['binding', 'input', 'snapshot', 'visibility', 'digest'] as const)(
    'rejects %s mismatch instead of advancing',
    async (field) => {
      const f = await open()
      try {
        const first = await f.provider.start(f.frame, f.ports)
        const receipt = f.succeed(action(first, 'left'))
        const frame = f.nextFrame(first)
        let ports = f.ports
        let detail = 'dag_receipt_identity'
        if (field === 'binding') receipt.bindingId = 'another-binding'
        if (field === 'visibility') {
          Object.assign(receipt, { visibility: 'pending' })
          detail = 'dag_receipt_invalid'
        }
        if (field === 'digest') receipt.inputDigest = '0'.repeat(64)
        if (field === 'input') {
          frame.input = contextInline(frame.input.schema, 'changed')
          detail = 'dag_state_identity'
        }
        if (field === 'snapshot') {
          ports = {
            ...ports,
            async query(request) {
              const result = await f.ports.query(request)
              return result.ok && result.value.kind === 'value'
                ? { ok: true, value: { ...result.value, snapshot: 'other-snapshot' } }
                : result
            },
          }
          detail = 'dag_receipt_snapshot'
        }
        fail(await f.provider.resume(frame, ports), detail)
      } finally {
        await f.close()
      }
    },
  )
  it('refuses prepare substitution and stored intent fingerprint drift', async () => {
    const f = await open()
    try {
      const ports: LoopReadPorts = {
        ...f.ports,
        prepare(spec) {
          const result = f.ports.prepare(spec)
          if (result.ok) result.value.method = 'substituted'
          return result
        },
      }
      fail(await f.provider.start(f.frame, ports), 'dag_prepare_substituted')
      const first = await f.provider.start(f.frame, f.ports)
      const frame = f.nextFrame(first)
      const saved = required(frame.continuation)
      if (saved.data.kind !== 'inline') throw new Error('Expected inline private state')
      const body = saved.data.value as unknown as { issued: W.PreparedAction[] }
      required(body.issued[0]).intentFingerprint = '0'.repeat(64)
      saved.data = contextInline(saved.data.schema, saved.data.value)
      fail(await f.provider.resume(frame, f.ports), 'dag_preparation_changed')
    } finally {
      await f.close()
    }
  })
  it.each(['all', 'any'] as const)(
    'refuses saved %s joins whose required predecessors were never issued',
    async (join) => {
      const f = await open(join)
      try {
        const first = await f.provider.start(f.frame, f.ports)
        const frame = f.nextFrame(first)
        const saved = required(frame.continuation)
        if (saved.data.kind !== 'inline') throw new Error('Expected inline private state')
        const joined = f.ports.prepare(required(f.graph.nodes.find((node) => node.id === 'join')).action)
        if (!joined.ok) throw new Error('Fixture refused graph action')
        const body = saved.data.value as unknown as { issued: W.PreparedAction[] }
        body.issued = join === 'all' ? [action(first, 'left'), joined.value] : [joined.value]
        saved.data = contextInline(saved.data.schema, saved.data.value)
        fail(await f.provider.resume(frame, f.ports), 'dag_saved_dependencies_missing')
      } finally {
        await f.close()
      }
    },
  )
})

import type * as W from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { contextInline } from '../../../extension-api/testkit/runtime/contracts/context.js'
import {
  type LoopContractFixture,
  runLoopContractScenario,
} from '../../../extension-api/testkit/runtime/contracts/loop.js'
import { createDefaultLoopFactory } from '../../src/runtime/providers/loop.js'

type Fixture = LoopContractFixture & {
  receipts: Map<string, W.ActionResultView>
  bindings: Record<string, W.BindingRef>
  source: {
    allowed: boolean
    blocked?: Promise<{ ok: true; value: undefined } | { ok: false; error: W.RuntimeError }>
  }
  issued: W.PreparedAction[]
}
async function open(): Promise<Fixture> {
  const module = (await import(
    new URL('../../../../tools/acceptance/runtime/platform/loop-conformance.ts', import.meta.url).href
  )) as { openLoopFixture(): Promise<Fixture> }
  return module.openLoopFixture()
}
async function ready() {
  const fixture = await open()
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  expect(await provider.ready(fixture.context)).toEqual({ ok: true, value: undefined })
  return { ...fixture, provider }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Loop fixture value absent')
  return value
}
function failure(transition: W.LoopTransition, detail?: string) {
  expect(transition.actions).toEqual([])
  expect(transition.next.kind).toBe('fail')
  if (transition.next.kind === 'fail' && detail) expect(transition.next.error.detailCode).toBe(detail)
}

describe('full C01 SPI text Loop candidate, restricted background peers', () => {
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)(
    'public contract %s',
    async (scenario) => {
      await runLoopContractScenario(scenario, open)
    },
  )
  it('does not claim cold State recovery from a map or a replacement instance', async () => {
    await expect(runLoopContractScenario('recover', open)).rejects.toThrow(
      'loop_cold_state_consumer_unavailable',
    )
  })
  it('plans stable actions, waits for visibility, and does not re-emit a pending effect', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const repeated = await f.provider.start(f.frame, f.ports)
      expect(repeated).toEqual(first)
      expect(first.actions[0]?.key).toBe('first-model')
      const frame = f.nextFrame(first)
      frame.observedAt = new Date(Date.parse(frame.observedAt) + 30_000).toISOString()
      const waiting = await f.provider.resume(frame, f.ports)
      expect(waiting.actions).toEqual([])
      expect(waiting.continuation).toEqual(
        first.continuation ? { ...first.continuation, createdAt: frame.observedAt } : null,
      )
      expect(waiting.next).toEqual(first.next)
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('keeps unknown effects unresolved even after the saved deadline', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const action = required(first.actions[0])
      await f.accept(action)
      required(f.receipts.get(action.key)).outcome = 'unknown_effect'
      const frame = f.nextFrame(first)
      frame.observedAt = '2090-01-01T00:00:00Z'
      const waiting = await f.provider.resume(frame, f.ports)
      expect(waiting.actions).toEqual([])
      expect(waiting.next).toEqual({
        kind: 'wait',
        condition: {
          anyOf: [
            { kind: 'actions', mode: 'all', actions: [{ localKey: 'first-model' }], readyWhen: 'resolved' },
          ],
        },
      })
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each(['inputDigest', 'bindingId', 'visibility'] as const)(
    'rejects a receipt with wrong %s',
    async (field) => {
      const f = await ready()
      try {
        const first = await f.provider.start(f.frame, f.ports)
        const action = required(first.actions[0])
        await f.accept(action)
        const receipt = required(f.receipts.get(action.key))
        if (field === 'inputDigest') receipt.inputDigest = canonicalJsonDigest('wrong input')
        else if (field === 'bindingId') receipt.bindingId = 'other-binding'
        else Object.assign(receipt, { visibility: 'pending' })
        failure(await f.provider.resume(f.nextFrame(first), f.ports))
      } finally {
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it('binds the classified tool to the original prepared model request and canonical definition', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const firstAction = required(first.actions[0])
      await f.accept(firstAction)
      const tool = await f.provider.resume(f.nextFrame(first), f.ports)
      const action = required(tool.actions[0])
      expect(action.resultSchema).toEqual(RuntimeSchemaRefs.ToolResult)
      if (action.input.kind !== 'inline' || firstAction.input.kind !== 'inline')
        throw new Error('inline fixture')
      const call = validateRuntime('ToolCall', action.input.value)
      const infer = validateRuntime('ModelInferRequest', firstAction.input.value)
      expect(call.ok && infer.ok).toBe(true)
      if (call.ok && infer.ok) {
        expect(call.value.modelContextRef).toEqual(infer.value.preparedRef)
        expect(call.value.expectedDefinitionDigest).toBe(canonicalJsonDigest(call.value.definition))
      }
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses a real conversation until its content codec and State consumption exist', async () => {
    const f = await ready()
    try {
      const frame = structuredClone(f.frame)
      frame.conversation = {
        turnId: 'turn',
        inputMessageId: 'message',
        kind: 'prompt',
        inputRef: frame.input,
      }
      failure(await f.provider.start(frame, f.ports), 'loop_conversation_codec_unavailable')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses missing authorized source before accepting traffic', async () => {
    const f = await open()
    try {
      const provider = await createDefaultLoopFactory(f.factory.descriptor).create(
        f.config,
        f.dependencies,
        f.factoryContext,
      )
      const result = await provider.ready(f.context)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.detailCode).toBe('loop_source_unavailable')
      await provider.close('shutdown')
    } finally {
      await f.close()
    }
  })
  it('rejects a foreign continuation producer or substituted checkpoint content', async () => {
    const f = await ready()
    try {
      const first = await f.provider.start(f.frame, f.ports)
      const frame = f.nextFrame(first)
      if (!frame.continuation) throw new Error('continuation expected')
      frame.continuation.provenance.producer.bindingId = 'other-loop'
      failure(await f.provider.resume(frame, f.ports), 'loop_state_producer')
      frame.continuation = structuredClone(first.continuation)
      if (frame.continuation?.data.kind !== 'inline') throw new Error('inline state')
      frame.continuation.data.value = { fake: 'replacement' }
      failure(await f.provider.resume(frame, f.ports), 'loop_data_integrity')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('rechecks authorization after a slow read before preparing any effect', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        async compute(request: W.ServiceOperation) {
          const value = await f.ports.compute(request)
          f.revoke()
          return value
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_fixture_revoked')
      expect(f.issued).toEqual([])
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('does not downgrade automatic preparation requests to an invented envelope', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare: () => ({
          ok: false as const,
          error: {
            code: 'incompatible' as const,
            detailCode: 'preparation_required',
            message: 'Official owner required',
            retryAdvice: { kind: 'never' as const },
            diagnosticId: 'f02',
          },
        }),
      }
      failure(await f.provider.start(f.frame, ports), 'preparation_required')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each(['first-model', 'tool'] as const)('refuses substituted %s preparation intent', async (stage) => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare(spec: W.ActionSpec) {
          const result = f.ports.prepare(spec)
          return result.ok
            ? {
                ok: true as const,
                value: { ...result.value, key: 'substituted', target: required(f.bindings.supervisor) },
              }
            : result
        },
      }
      if (stage === 'first-model')
        failure(await f.provider.start(f.frame, ports), 'loop_prepared_action_substituted')
      else {
        const first = await f.provider.start(f.frame, f.ports)
        await f.accept(required(first.actions[0]))
        failure(
          await f.provider.resume(f.nextFrame(first), {
            ...ports,
            prepare(spec) {
              if (spec.key !== 'tool') return f.ports.prepare(spec)
              return ports.prepare(spec)
            },
          }),
          'loop_prepared_action_substituted',
        )
      }
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('rejects same-input context output from a different snapshot', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        async query(request: W.ServiceQuery) {
          const reply = await f.ports.query(request)
          return reply.ok && reply.value.kind === 'value' && request.target.contract === 'agh.context'
            ? { ok: true as const, value: { ...reply.value, snapshot: 'different-snapshot' } }
            : reply
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_context_snapshot')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('refuses preparation that mutates its request object in place', async () => {
    const f = await ready()
    try {
      const ports = {
        ...f.ports,
        prepare(spec: W.ActionSpec) {
          spec.key = 'substituted'
          return f.ports.prepare(spec)
        },
      }
      failure(await f.provider.start(f.frame, ports), 'loop_prepared_action_substituted')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it('fixes the original factory binding instead of rereading a mutable assembly object', async () => {
    const f = await ready()
    try {
      f.factoryContext.bindingId = 'changed-after-create'
      const planned = await f.provider.start(f.frame, f.ports)
      expect(planned.next.kind).toBe('wait')
      expect(planned.actions[0]?.key).toBe('first-model')
    } finally {
      await f.provider.close('shutdown')
      await f.close()
    }
  })
  it.each([RuntimeMethodSchemaRefs['agh.tools'].invoke.output, RuntimeSchemaRefs.ToolResult])(
    'rejects non-model-visible Tool result codec before calling the next model',
    async (schema) => {
      const f = await ready()
      try {
        const first = await f.provider.start(f.frame, f.ports)
        await f.accept(required(first.actions[0]))
        const tool = await f.provider.resume(f.nextFrame(first), f.ports)
        await f.accept(required(tool.actions[0]))
        const receipt = required(f.receipts.get('tool'))
        if (receipt.result?.kind !== 'inline') throw new Error('tool output')
        receipt.result = contextInline(schema, receipt.result.value)
        failure(await f.provider.resume(f.nextFrame(tool), f.ports), 'loop_data_schema')
      } finally {
        await f.provider.close('shutdown')
        await f.close()
      }
    },
  )
  it('times out a noncooperative source and keeps drain blocked until that read settles', async () => {
    const f = await ready()
    let release: ((value: { ok: true; value: undefined }) => void) | undefined
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      f.source.blocked = new Promise((resolve) => {
        release = resolve
      })
      const frame = structuredClone(f.frame)
      frame.context.deadline = new Date(Date.now() + 25).toISOString()
      const pending = f.provider.start(frame, f.ports)
      await vi.advanceTimersByTimeAsync(26)
      failure(await pending, 'loop_invocation_expired')
      const draining = await f.provider.drain(f.context.deadline, f.context)
      expect(draining.ok && draining.value.state).toBe('blocked')
      required(release)({ ok: true, value: undefined })
      await f.source.blocked
      await new Promise<void>((resolve) => setImmediate(resolve))
      const drained = await f.provider.drain(f.context.deadline, f.context)
      expect(drained.ok && drained.value.state).toBe('drained')
    } finally {
      vi.useRealTimers()
      release?.({ ok: true, value: undefined })
      await f.provider.close('shutdown')
      await f.close()
    }
  })
})

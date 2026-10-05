import type { LeafActionProvider, Outcome } from '@agnes/extension-api/runtime'
import type { ToolCall } from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createPureToolAuthorAdapter } from '../../../../packages/extension-api/src/runtime/tool-authoring.js'
import { runToolsContractScenario } from '../../../../packages/extension-api/testkit/runtime/contracts/tools.js'
import { createReferenceTextStatisticsTool } from '../../src/providers/tools.js'

async function fixture(text?: string, overrides?: object) {
  const fixtures = await import(
    new URL('../../../../packages/core/test/runtime/tools-fixture.js', import.meta.url).href
  )
  return fixtures.openToolsFixture('reference', text, overrides)
}
function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
async function open(text?: string, overrides?: object) {
  const input = await fixture(text, overrides)
  const service = await input.factory.create(input.configuration, input.dependencies, input.factoryContext)
  const action = (await service.actions.invoke.create({
    instanceId: input.factoryContext.instanceId,
    actionId: input.frame.actionId,
    runId: input.frame.runId,
    bindingId: input.frame.bindingId,
    scope: input.call.scope,
    signal: input.call.signal,
  })) as LeafActionProvider
  return {
    input,
    service,
    action,
    async close() {
      await action.close('shutdown')
      await service.close('shutdown')
    },
  }
}

describe('independent reference text statistics Tools', () => {
  it.each([
    ['', { characters: 0, words: 0, lines: 0 }],
    ['🙂皇上', { characters: 3, words: 1, lines: 1 }],
    ['one\r\ntwo\rthree\nfour\n', { characters: 20, words: 4, lines: 5 }],
    [' \t\n', { characters: 3, words: 0, lines: 2 }],
    ['a\u00a0b\u2028c', { characters: 5, words: 3, lines: 1 }],
    ['e\u0301', { characters: 2, words: 1, lines: 1 }],
    ['\r\n\r\n', { characters: 4, words: 0, lines: 3 }],
  ])('counts fixed text %j using the independent algorithm', async (text, expected) => {
    const author = createReferenceTextStatisticsTool()
    const result = await author.execute(
      { content: [{ type: 'text', text }] },
      { signal: new AbortController().signal, config: {} },
    )
    expect(result.structured).toEqual(expected)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `characters=${expected.characters}; words=${expected.words}; lines=${expected.lines}`,
      },
    ])
  })

  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)(
    'passes the public %s contract scenario',
    async (scenario) => {
      const result = await runToolsContractScenario(scenario, {
        open: () => fixture(),
        coldRecover: async () => {
          throw new Error('Cold recovery belongs to the real-process suite')
        },
      })
      expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/u)
    },
  )

  it('checks current authorization before reporting lifecycle health', async () => {
    const selected = await open()
    try {
      const health = value(await selected.service.health(selected.input.call))
      expect(validateRuntime('Health', health).ok).toBe(true)
      selected.input.revoke()
      expect((await selected.service.health(selected.input.call)).ok).toBe(false)
      expect((await selected.action.health(selected.input.call)).ok).toBe(false)
    } finally {
      await selected.close()
    }
  })

  it('refuses a recomputed fingerprint that changes the frozen pure policy', async () => {
    const selected = await open()
    try {
      const fixtures = await import(
        new URL('../../../../packages/core/test/runtime/tools-fixture.js', import.meta.url).href
      )
      const original = selected.input.frame.input.value
      const { fingerprint: _fingerprint, ...policy } = original.policy
      const forged = { ...policy, requiresApproval: 'always' }
      const input = fixtures.toolsRef(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, {
        ...original,
        policy: { ...forged, fingerprint: canonicalJsonDigest(forged) },
      })
      const result = await selected.action.execute(
        { ...selected.input.frame, input, inputDigest: input.digest },
        selected.input.actionContext,
      )
      expect(result.outcome).toBe('failed')
      expect(result.error?.detailCode).toBe('tools_call_identity')
      for (const [change, detailCode] of [
        [{ modelContextRef: selected.input.describe }, 'tools_model_context_source_unavailable'],
        [
          { batchRef: { batchId: 'synthetic-batch', ordinal: 0, parentBatchId: null } },
          'tools_batch_source_unavailable',
        ],
      ] as const) {
        const unsupportedInput = fixtures.toolsRef(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, {
          ...original,
          ...change,
        })
        const refused = await selected.action.execute(
          { ...selected.input.frame, input: unsupportedInput, inputDigest: unsupportedInput.digest },
          selected.input.actionContext,
        )
        expect(refused).toMatchObject({ outcome: 'failed', error: { code: 'incompatible', detailCode } })
      }
      expect(selected.input.effectsCount()).toBe(0)
    } finally {
      await selected.close()
    }
  })

  it('refuses unavailable verified source without dispatching the pure author', async () => {
    const selected = await open(undefined, {
      verifyCall: async () => ({
        ok: false,
        error: {
          code: 'incompatible',
          detailCode: 'effects_stage_source_unavailable',
          message: 'Pure stage source unavailable',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'source',
        },
      }),
      createExecutor() {
        throw new Error('A denied source must not reach this executor')
      },
    })
    try {
      const result = await selected.action.execute(selected.input.frame, selected.input.actionContext)
      expect(result.error?.detailCode).toBe('effects_stage_source_unavailable')
      expect(selected.input.effectsCount()).toBe(0)
    } finally {
      await selected.close()
    }
  })

  it('freezes the incoming frame before awaiting current permission', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const selected = await open(undefined, {
      checkCurrent: async () => {
        await gate
        return { ok: true, value: undefined }
      },
    })
    try {
      const execution = selected.action.execute(selected.input.frame, selected.input.actionContext)
      selected.input.frame.inputDigest = 'f'.repeat(64)
      release()
      expect(await execution).toMatchObject({ outcome: 'succeeded' })
    } finally {
      release()
      await selected.close()
    }
  })

  it('returns an Outcome for malformed queries and names unsupported commands', async () => {
    const selected = await open()
    try {
      const request = {
        target: selected.input.definition.executor,
        method: 'describe',
        input: selected.input.describe,
        extra: true,
      }
      const wrongCaller = { ...selected.input.call, bindingId: 'another-tools-binding' }
      expect((await selected.service.drain(new Date().toISOString(), wrongCaller)).ok).toBe(false)
      expect((await selected.action.drain(new Date().toISOString(), wrongCaller)).ok).toBe(false)
      expect(
        (
          await selected.service.query(
            { target: request.target, method: request.method, input: request.input },
            selected.input.call,
          )
        ).ok,
      ).toBe(true)
      expect((await selected.service.query(request, selected.input.call)).ok).toBe(false)
      expect(
        (
          await selected.service.compute(
            { target: request.target, method: 'updatePlan', input: request.input },
            selected.input.call,
          )
        ).error?.detailCode,
      ).toBe('tools_compute_unsupported')
      await expect(
        selected.action.reconcile(selected.input.frame, [], selected.input.actionContext),
      ).rejects.toMatchObject({ detailCode: 'tools_receipt_source_unavailable' })
    } finally {
      await selected.close()
    }
  })

  it('keeps an aborted author reachable until its real promise has settled', async () => {
    let release: () => void = () => {},
      started: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let input: Awaited<ReturnType<typeof fixture>>
    const selected = await open(undefined, {
      createExecutor(toolCall: ToolCall) {
        return createPureToolAuthorAdapter(
          {
            ...input.author,
            async execute() {
              started()
              await gate
              return input.expected
            },
          },
          {
            definition: input.definition,
            inputDigest:
              toolCall.input.kind === 'inline' ? toolCall.input.digest : toolCall.input.blob.digest,
            provenance: {
              sourceRefs: ['synthetic-retained-text-source'],
              producer: input.definition.executor,
              trustLabels: ['derived'],
            },
          },
        )
      },
    })
    input = selected.input
    const controller = new AbortController()
    try {
      const execution = selected.action.execute(input.frame, {
        ...input.actionContext,
        call: { ...input.call, signal: controller.signal },
      })
      await entered
      controller.abort()
      expect((await execution).outcome).toBe('cancelled')
      const drain = value(await selected.service.drain(new Date().toISOString(), input.call))
      expect(drain.state).toBe('blocked')
      expect(drain.activeInvocationIds).toContain(input.call.invocationId)
      release()
    } finally {
      release()
      await selected.close()
    }
  })

  it('honors the earlier action deadline while native admission remains pending', async () => {
    let release: () => void = () => {},
      started: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const selected = await open(undefined, {
      checkCurrent: async () => {
        started()
        await gate
        return { ok: true, value: undefined }
      },
    })
    vi.useFakeTimers()
    try {
      const frame = {
        ...selected.input.frame,
        actionTimebox: {
          ...selected.input.frame.actionTimebox,
          maxDeadline: new Date(Date.now() + 25).toISOString(),
        },
      }
      const pending = selected.action.execute(frame, selected.input.actionContext)
      await entered
      await vi.advanceTimersByTimeAsync(25)
      expect(await pending).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
      expect(selected.input.effectsCount()).toBe(0)
    } finally {
      release()
      vi.useRealTimers()
      await selected.close()
    }
  })
})

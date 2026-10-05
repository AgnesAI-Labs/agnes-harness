import { defineTool, runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createPureToolAuthorAdapter } from '../../../extension-api/src/runtime/tool-authoring.js'
import { runToolsContractScenario } from '../../../extension-api/testkit/runtime/contracts/tools.js'
import { openToolsFixture, toolsRef, toolsValue } from './tools-fixture.js'

async function setup(
  kind: 'default' | 'reference' = 'default',
  overrides: Parameters<typeof openToolsFixture>[2] = {},
) {
  const fixture = await openToolsFixture(kind, undefined, overrides)
  const provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const actionFactory = provider.actions?.invoke
  if (!actionFactory || !provider.query || !provider.compute) throw new Error('Tools methods required')
  const leaf = await actionFactory.create({
    instanceId: 'tools-instance',
    actionId: fixture.frame.actionId,
    runId: fixture.frame.runId,
    bindingId: fixture.frame.bindingId,
    scope: fixture.call.scope,
    signal: fixture.call.signal,
  })
  if (leaf.kind !== 'leaf') throw new Error('Leaf required')
  return {
    ...fixture,
    provider: {
      ...provider,
      query: provider.query,
      compute: provider.compute,
      actions: provider.actions ?? {},
    },
    leaf,
    target: fixture.definition.executor,
  }
}
describe.each(['default', 'reference'] as const)('fixed text Tools %s', (kind) => {
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)('contract %s', async (scenario) => {
    await runToolsContractScenario(scenario, {
      open: () => openToolsFixture(kind),
      coldRecover: async () => {
        throw new Error('Cold recover belongs to actual process test')
      },
    })
  })
  it.each(['', '🙂', 'one\r\ntwo\rthree\nfour\n', '   a\t b  ', '中 文\u00a0🙂'])(
    'counts fixed Unicode/word/newline input %j',
    async (text) => {
      const fixture = await openToolsFixture(kind, text)
      await runToolsContractScenario('normal', {
        open: async () => fixture,
        coldRecover: async () => {
          throw new Error('No fake cold recovery')
        },
      })
    },
  )
  it('refuses changed definition, policy, payload digest and unknown query fields before effects', async () => {
    const test = await setup(kind)
    try {
      if (test.frame.input.kind !== 'inline') throw new Error('Inline fixture')
      const original = test.frame.input.value as Record<string, unknown>
      for (const change of [
        { expectedDefinitionDigest: '0'.repeat(64) },
        { policy: { ...(original.policy as object), isDestructive: true } },
        { definition: { ...test.definition, name: 'other-tool' } },
      ]) {
        const input = toolsRef(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, { ...original, ...change })
        if (input.kind !== 'inline') throw new Error('Inline fixture')
        expect(
          (await test.leaf.execute({ ...test.frame, input, inputDigest: input.digest }, test.actionContext))
            .outcome,
        ).not.toBe('succeeded')
      }
      expect(
        (
          await test.provider.compute(
            {
              target: test.target,
              method: 'classify',
              input: { ...test.classify, digest: 'f'.repeat(64) } as typeof test.classify,
            },
            test.call,
          )
        ).ok,
      ).toBe(false)
      expect(
        (
          await test.provider.query(
            { target: test.target, method: 'describe', input: test.describe, extra: true } as never,
            test.call,
          )
        ).ok,
      ).toBe(false)
      const modelCall = toolsRef(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, {
        ...original,
        modelContextRef: test.frame.input,
      })
      if (modelCall.kind !== 'inline') throw new Error('Inline fixture')
      expect(
        await test.leaf.execute(
          { ...test.frame, input: modelCall, inputDigest: modelCall.digest },
          test.actionContext,
        ),
      ).toMatchObject({
        outcome: 'failed',
        error: { code: 'incompatible', detailCode: 'tools_model_context_source_unavailable' },
      })
      expect(test.effectsCount()).toBe(0)
    } finally {
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
  it('freezes frame before asynchronous authorization', async () => {
    let release: () => void = () => {},
      entered: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      read = new Promise<void>((resolve) => {
        entered = resolve
      })
    let calls = 0
    const test = await setup(kind, {
      checkCurrent: async () => {
        if (calls++ === 0) {
          entered()
          await gate
        }
        return { ok: true, value: undefined }
      },
    })
    try {
      const frame = structuredClone(test.frame),
        expected = structuredClone(frame)
      const running = test.leaf.execute(frame, test.actionContext)
      await read
      frame.runId = 'other-run'
      release()
      const result = await running
      expect(result.outcome).toBe('succeeded')
      expect(test.frame).toEqual(expected)
      expect(test.effectsCount()).toBe(0)
    } finally {
      release()
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
  it('keeps cancelled uncompleted author work visible to drain until it really ends', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let finish: () => void = () => {},
      started: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
        finish = resolve
      }),
      entered = new Promise<void>((resolve) => {
        started = resolve
      })
    const delayed = defineTool({
      id: 'text-statistics',
      description: 'Delayed synthetic pure computation',
      execution: 'pure',
      input: runtimeAuthorSchemas.StandardToolOutput,
      async execute(input) {
        started()
        await pending
        return input
      },
    })
    let test: Awaited<ReturnType<typeof setup>>
    test = await setup(kind, {
      createExecutor: (call) =>
        createPureToolAuthorAdapter(delayed, {
          definition: test.definition,
          inputDigest: call.input.kind === 'inline' ? call.input.digest : call.input.blob.digest,
          provenance: {
            sourceRefs: ['synthetic-source'],
            producer: test.definition.executor,
            trustLabels: ['derived'],
          },
        }),
    })
    try {
      const running = test.leaf.execute(test.frame, test.actionContext)
      await entered
      const draining = test.provider.drain(new Date(Date.now() + 5).toISOString(), test.call)
      await vi.advanceTimersByTimeAsync(6)
      const drained = toolsValue(await draining)
      expect(drained.state).toBe('blocked')
      expect((await running).outcome).not.toBe('succeeded')
      finish()
      await pending
      await new Promise((resolve) => setImmediate(resolve))
      expect(toolsValue(await test.provider.drain(test.call.deadline, test.call)).state).toBe('drained')
    } finally {
      finish()
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
      vi.useRealTimers()
    }
  })
  it('does not claim unsupported durable commands or forge reconciliation receipts', async () => {
    const test = await setup(kind)
    try {
      expect(Object.keys(test.provider.actions)).toEqual(['invoke'])
      await expect(test.leaf.reconcile(test.frame, [], test.actionContext)).rejects.toMatchObject({
        detailCode: 'tools_receipt_source_unavailable',
      })
      expect(
        (
          await test.provider.query(
            { target: test.target, method: 'inspect', input: test.describe },
            test.call,
          )
        ).ok,
      ).toBe(false)
      expect(canonicalJsonDigest(test.definition)).not.toBe(test.definition.resource.digest)
    } finally {
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
  it('cancels pending native authorization promptly and preserves it as blocked until it settles', async () => {
    let release: () => void = () => {},
      entered: () => void = () => {},
      waiting = true
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve
      })
    const test = await setup(kind, {
      checkCurrent: async () => {
        if (waiting) {
          waiting = false
          entered()
          await gate
        }
        return { ok: true, value: undefined }
      },
    })
    const cancel = new AbortController()
    try {
      const pending = test.provider.compute(
        { target: test.target, method: 'classify', input: test.classify },
        { ...test.call, signal: cancel.signal },
      )
      await started
      cancel.abort()
      expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(toolsValue(await test.provider.drain(test.call.deadline, test.call)).state).toBe('blocked')
      release()
      await gate
      await new Promise((resolve) => setImmediate(resolve))
      expect(toolsValue(await test.provider.drain(test.call.deadline, test.call)).state).toBe('drained')
    } finally {
      release()
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
  it('keeps one fixed caller identity across asynchronous authorization and refuses invalid drain', async () => {
    let release: () => void = () => {},
      entered: () => void = () => {},
      waiting = true
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve
      })
    const test = await setup(kind, {
      checkCurrent: async (call) => {
        if (waiting) {
          waiting = false
          entered()
          await gate
        }
        return call.principalRef === 'synthetic-principal'
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'synthetic-other-principal',
                message: 'Different synthetic caller',
                retryAdvice: { kind: 'never' },
                diagnosticId: 'tools-test',
              },
            }
      },
    })
    try {
      const call = { ...test.call },
        pending = test.provider.compute(
          { target: test.target, method: 'classify', input: test.classify },
          call,
        )
      await started
      call.principalRef = 'another-principal'
      release()
      expect((await pending).ok).toBe(true)
      expect(
        (await test.provider.compute({ target: test.target, method: 'classify', input: test.classify }, call))
          .ok,
      ).toBe(false)
      expect(
        (await test.provider.drain(test.call.deadline, { ...test.call, bindingId: 'another-binding' })).ok,
      ).toBe(false)
      expect(
        (
          await test.provider.compute(
            { target: test.target, method: 'classify', input: test.classify },
            test.call,
          )
        ).ok,
      ).toBe(true)
      expect(
        (
          await test.leaf.health({
            ...test.call,
            scope: { ...test.call.scope, actionId: 'sibling-action' },
          } as typeof test.call)
        ).ok,
      ).toBe(false)
    } finally {
      release()
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
  it.each(['service', 'leaf'] as const)(
    'keeps the original %s drain caller through native authorization',
    async (owner) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      let releaseAuthor: () => void = () => {},
        authorEntered: () => void = () => {},
        releaseAdmission: () => void = () => {},
        admissionEntered: () => void = () => {},
        blockAdmission = false
      const author = new Promise<void>((resolve) => {
          releaseAuthor = resolve
        }),
        authorStarted = new Promise<void>((resolve) => {
          authorEntered = resolve
        }),
        admission = new Promise<void>((resolve) => {
          releaseAdmission = resolve
        }),
        admissionStarted = new Promise<void>((resolve) => {
          admissionEntered = resolve
        })
      const delayed = defineTool({
        id: 'text-statistics',
        description: 'Synthetic pending pure tool',
        execution: 'pure',
        input: runtimeAuthorSchemas.StandardToolOutput,
        async execute(input) {
          authorEntered()
          await author
          return input
        },
      })
      let test: Awaited<ReturnType<typeof setup>>
      test = await setup(kind, {
        checkCurrent: async () => {
          if (blockAdmission) {
            blockAdmission = false
            admissionEntered()
            await admission
          }
          return { ok: true, value: undefined }
        },
        createExecutor: (call) =>
          createPureToolAuthorAdapter(delayed, {
            definition: test.definition,
            inputDigest: call.input.kind === 'inline' ? call.input.digest : call.input.blob.digest,
            provenance: {
              sourceRefs: ['synthetic-source'],
              producer: test.definition.executor,
              trustLabels: ['derived'],
            },
          }),
      })
      try {
        const running = test.leaf.execute(test.frame, test.actionContext)
        await authorStarted
        blockAdmission = true
        const call = { ...test.call },
          draining = (owner === 'service' ? test.provider : test.leaf).drain(
            new Date(Date.now() + 5).toISOString(),
            call,
          )
        await admissionStarted
        call.bindingId = 'different-binding'
        call.invocationId = 'different-invocation'
        releaseAdmission()
        await vi.advanceTimersByTimeAsync(6)
        const result = toolsValue(await draining)
        expect(result.state).toBe('blocked')
        expect(result.activeInvocationIds).toContain(test.call.invocationId)
        expect(result.activeInvocationIds).not.toContain('different-invocation')
        expect((await running).outcome).not.toBe('succeeded')
      } finally {
        releaseAdmission()
        releaseAuthor()
        await test.leaf.close('shutdown')
        await test.provider.close('shutdown')
        vi.useRealTimers()
      }
    },
  )
  it('bounds pending authorization by the original action deadline rather than a later invocation deadline', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {},
      entered: () => void = () => {},
      waiting = true
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve
      })
    const test = await setup(kind, {
      checkCurrent: async () => {
        if (waiting) {
          waiting = false
          entered()
          await gate
        }
        return { ok: true, value: undefined }
      },
    })
    try {
      const frame = {
        ...test.frame,
        actionTimebox: { ...test.frame.actionTimebox, maxDeadline: new Date(Date.now() + 100).toISOString() },
      }
      const pending = test.leaf.execute(frame, test.actionContext)
      await started
      await vi.advanceTimersByTimeAsync(101)
      expect(await pending).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
      expect(test.effectsCount()).toBe(0)
    } finally {
      release()
      await gate
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
      vi.useRealTimers()
    }
  })
  it('allows an immediate drain without inventing active work after pure completion', async () => {
    const test = await setup(kind)
    try {
      expect((await test.leaf.execute(test.frame, test.actionContext)).outcome).toBe('succeeded')
      expect(toolsValue(await test.provider.drain(new Date().toISOString(), test.call)).state).toBe('drained')
    } finally {
      await test.leaf.close('shutdown')
      await test.provider.close('shutdown')
    }
  })
})

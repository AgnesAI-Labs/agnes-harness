import type {
  DecisionHandle,
  DecisionSnapshot,
  DecisionSpec,
  LoopCheckpoint,
  LoopContext,
  LoopInput,
  LoopToolCall,
  ToolResult,
} from '@agnes/extension-api'
import { unavailableDecisions } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { defineWorkflowLoop, type WorkflowOptions, workflowResult, workflowValue } from '../src/index.js'

const signal = new AbortController().signal
const actor = { id: 'fixture', org: 'fixture', role: 'owner', deptPath: [], attrs: {} }
const input = (id: string, content = 'Start'): LoopInput => ({
  id,
  turnId: 1,
  actor,
  kind: 'prompt',
  trust: 'untrusted',
  content: [{ type: 'text', text: content }],
})
const definition = (options: Partial<WorkflowOptions> = {}) =>
  defineWorkflowLoop({
    id: 'test.workflow',
    version: '1.0.0',
    name: 'workflow',
    stages: [
      {
        name: 'draft',
        async run(_ctx, state) {
          return { draft: state.input }
        },
      },
    ],
    ...options,
  })
function fixture() {
  const inputs: LoopInput[] = [input('start')]
  const calls: LoopToolCall[] = []
  const effects: LoopToolCall[] = []
  const receipts = new Map<string, ToolResult>()
  const finishes: string[] = []
  const messages: string[] = []
  const decisions: DecisionHandle[] = []
  const consumed: DecisionHandle[] = []
  const checkpoints: LoopCheckpoint[] = []
  let checkpoint: LoopCheckpoint | null = null
  let parkTool = ''
  let resumed: Awaited<ReturnType<LoopContext['input']['resumeParked']>> = 'opened'
  let cancelled = false
  let decision: DecisionSnapshot | null = null
  let request: DecisionSpec | null = null
  let resumeError = ''
  let continuation: ReturnType<LoopContext['turn']['continuation']> = null
  const execute: LoopContext['tools']['execute'] = async (call) => {
    calls.push(structuredClone(call))
    const previous = call.invocationId ? receipts.get(call.invocationId) : undefined
    if (previous) return previous
    if (call.name === parkTool) throw Object.assign(new Error('Approval parked'), { code: 'PARKED' })
    if (call.name === 'ask_user_question')
      return { ...workflowResult({}), details: { status: 'pending', surfaceId: 'question' } }
    return workflowResult({})
  }
  const ctx: LoopContext = {
    decisions: {
      ...unavailableDecisions,
      async request(spec) {
        request = spec
        const handle = { id: 'decision', sessionId: 'fixture' }
        decisions.push(handle)
        return handle
      },
      async get() {
        if (!decision) throw new Error('Supply a decision snapshot')
        return decision
      },
      async wait(handle) {
        return { status: 'pending', handle, waitEndedBy: 'detached' }
      },
    },
    session: { key: 'fixture', lane: 'main', workspaceRoot: '/fixture' },
    sessionKey: 'fixture',
    lane: 'main',
    async prepareRequest() {
      throw new Error('Model completion fixture ignores preparation')
    },
    async estimateRequest() {
      throw new Error('Unused')
    },
    turn: {
      view: async () => null,
      continuation: () => continuation,
      cancelled: () => cancelled,
      endStep: async () => {},
      checkpoint: async () => {
        continuation = 'model'
        return { outcome: 'running' }
      },
      finishCancelled: async () => ({ outcome: 'turn-ended', reason: 'aborted' }),
      finishFailure: async () => ({ outcome: 'turn-ended', reason: 'error' }),
    },
    effects: { status: async (id) => ({ status: 'not-sent', invocationId: id }) },
    model: {
      respond: async () => ({ outcome: 'running' }),
      async *stream() {},
      complete: async () => [
        { type: 'text_delta', delta: 'Explain' },
        { type: 'done', reason: 'stop' },
      ],
    },
    tools: {
      execute,
      batch: (batch) => Promise.all(batch.map((call) => execute(call, signal))),
      drain: async () => ({ outcome: 'running' }),
      async resume(id) {
        if (resumeError) throw Object.assign(new Error('Resume refused'), { code: resumeError })
        const call = calls.find((call) => call.invocationId === id)
        if (!call) throw new Error('Original call missing')
        if (!receipts.has(id)) {
          effects.push(structuredClone(call))
          receipts.set(id, workflowResult({ receipt: 'committed' }))
        }
        const result = receipts.get(id)
        if (!result) throw new Error('Missing receipt')
        return result
      },
    },
    input: {
      accept: async () => inputs.shift() ?? null,
      claim: async () => inputs.shift() ?? null,
      resumeParked: async () => resumed,
      pending: () => inputs.length > 0,
    },
    events: {
      emit: async () => {},
      async assistant(message, next) {
        messages.push(JSON.stringify(message))
        checkpoint = next
      },
      async finish(reason) {
        finishes.push(reason)
        return { outcome: reason === 'parked' ? 'parked' : 'turn-ended', reason }
      },
    },
    checkpoints: {
      read: () => checkpoint,
      async write(next, association) {
        checkpoint = structuredClone(next)
        checkpoints.push(checkpoint)
        consumed.push(...(association?.decisionRefs ?? []))
      },
    },
    wait: {
      park: async () => {},
      wake: async () => {},
      poll: async () => ({ outcome: 'idle' }),
      delay: async () => {},
    },
    jobs: {
      status: async () => {
        throw new Error('Unused')
      },
      join: async () => {
        throw new Error('Unused')
      },
    },
  }
  return {
    ctx,
    inputs,
    calls,
    effects,
    finishes,
    messages,
    decisions,
    consumed,
    checkpoints,
    checkpoint: () => {
      if (!checkpoint) throw new Error('No checkpoint')
      return checkpoint
    },
    park: (tool: string) => {
      parkTool = tool
    },
    resume: (status: typeof resumed) => {
      resumed = status
    },
    stop: () => {
      cancelled = true
    },
    continuation: (value: typeof continuation) => {
      continuation = value
    },
    failResume: (code: string) => {
      resumeError = code
    },
    answer(
      option: string | null,
      reason: 'answered' | 'stopped' | 'expired' | 'unavailable' | 'invalidated' = 'answered',
    ) {
      if (!request) throw new Error('No original decision')
      const handle = decisions[0]
      if (!handle) throw new Error('Missing handle')
      decision = {
        handle,
        revision: 1,
        request: {
          spec: request,
          subjectDigest: 'a'.repeat(64),
          owner: 'loop:test.workflow',
          operationId: 'fixture',
          sourcePackage: '@test/workflow',
          packageVersion: '1.0.0',
          requestedBy: actor,
          lane: 'main',
          createdAt: '2026-10-12T00:00:00Z',
          expiresAt: null,
        },
        result:
          option === null
            ? null
            : reason === 'answered'
              ? {
                  reason: 'answered',
                  response: { option, value: null },
                  answeredBy: actor,
                  at: '2026-10-12T00:00:00Z',
                }
              : { reason, code: 'UNAVAILABLE', at: '2026-10-12T00:00:00Z' },
        invalidation: null,
        consumption: null,
        answerCommand: null,
      }
    },
  }
}

async function withModel(f: ReturnType<typeof fixture>) {
  // Reuse the public testkit's branded request preparation rather than casting a RequestBody.
  const { driveLoop } = await import('../testkit/loop.js')
  const factory = definition().factory
  await driveLoop({
    ...factory,
    create(ctx) {
      f.ctx.prepareRequest = ctx.prepareRequest
      return {
        step: async () => ({ outcome: 'idle' }),
        checkpoint: () => ({ codecVersion: 1, state: {} }),
        cancel() {},
        dispose() {},
      }
    },
  })
}
const state = (saved: LoopCheckpoint) => {
  if (!saved.state || typeof saved.state !== 'object' || Array.isArray(saved.state))
    throw new Error('Invalid checkpoint state')
  return saved.state
}

describe('official workflow state machine', () => {
  it('advances stages, publishes draft/final files and resumes completed work idempotently', async () => {
    const f = fixture()
    const { factory } = definition({
      deliverables: { directory: 'output/workflow', markdown: () => '# Review' },
    })
    const driver = await factory.create(f.ctx)
    expect((await driver.step(signal)).phase).toBe('approve-plan')
    expect((await driver.step(signal)).phase).toBe('draft')
    expect((await driver.step(signal)).phase).toBe('present-deliverables')
    expect(await driver.step(signal)).toMatchObject({ outcome: 'turn-ended', reason: 'completed' })
    expect(f.calls.filter((call) => call.name === 'write').map((call) => call.args)).toEqual([
      { path: expect.stringMatching(/^output\/workflow\/[a-f0-9]{64}\/2-report.md$/), content: '# Review' },
    ])
    expect(state(f.checkpoint()).data).toMatchObject({ draft: 'Start', deliverables: [] })
    const reopened = await factory.resume(f.ctx, f.checkpoint())
    expect((await reopened.step(signal)).outcome).toBe('idle')
    expect(f.finishes).toEqual(['completed'])
    f.inputs.push(input('another', 'Next'))
    expect((await reopened.step(signal)).phase).toBe('approve-plan')
    expect(state(f.checkpoint()).input).toBe('Next')
  })

  it('reports presented files as the present line, never as artifact references', async () => {
    const f = fixture()
    const sha256 = 'a'.repeat(64)
    const execute = f.ctx.tools.execute
    f.ctx.tools.execute = async (call, signal) =>
      call.name === 'present'
        ? {
            ...workflowResult({}),
            details: {
              deliverables: [
                {
                  name: 'report.md',
                  description: 'workflow: final',
                  ref: { sha256, size: 9, mime: 'text/markdown' },
                },
              ],
            },
          }
        : execute(call, signal)
    const { factory } = definition({
      deliverables: { directory: 'output/workflow', markdown: () => '# Review' },
    })
    const driver = await factory.create(f.ctx)
    for (let step = 0; step < 3; step++) await driver.step(signal)
    const last = JSON.parse(f.messages.at(-1) ?? '{}') as { content?: { text?: string }[] }
    expect(last.content?.[0]?.text).toBe('Presented report.md')
    expect(f.messages.at(-1)).not.toContain(sha256)
    expect(f.messages.at(-1)).not.toContain('present-deliverables')
  })

  it.each(['Proceed', 'Cancel', 'stopped', 'expired', 'unavailable', 'invalidated'] as const)(
    'resumes the original DecisionPort confirmation: %s',
    async (answer) => {
      const f = fixture()
      await withModel(f)
      const { factory } = definition({
        stages: [
          {
            name: 'action',
            confirm: () => 'Record?',
            async run() {
              return { recorded: true }
            },
          },
        ],
      })
      let driver = await factory.create(f.ctx)
      await driver.step(signal)
      expect((await driver.step(signal)).outcome).toBe('parked')
      f.answer(null)
      driver = await factory.resume(f.ctx, f.checkpoint())
      expect((await driver.step(signal)).outcome).toBe('parked')
      f.answer(answer, answer === 'Proceed' || answer === 'Cancel' ? 'answered' : answer)
      const result = await driver.step(signal)
      if (answer === 'Proceed') {
        expect(result).toMatchObject({ outcome: 'running', phase: 'action' })
        expect(state(f.checkpoint()).data).toMatchObject({ recorded: true })
      } else {
        expect(result).toMatchObject({
          outcome: 'turn-ended',
          reason: answer === 'Cancel' ? 'error' : 'blocked',
        })
        expect(state(f.checkpoint()).data).not.toHaveProperty('recorded')
      }
      expect(f.decisions).toHaveLength(1)
      expect(f.consumed).toEqual(answer === 'Proceed' || answer === 'Cancel' ? f.decisions : [])
    },
  )

  it.each(['waiting', false, 'blocked', 'E_LANE_BUSY', 'PARKED', 'opened'] as const)(
    'honors approval resume %s and never repeats the effect',
    async (status) => {
      const f = fixture()
      await withModel(f)
      f.park('business-write')
      const { factory } = definition({
        stages: [
          {
            name: 'action',
            approval: true,
            async run(ctx, _state, signal) {
              return {
                receipt: workflowValue(await ctx.tools.execute({ name: 'business-write', args: {} }, signal)),
              }
            },
          },
        ],
      })
      let driver = await factory.create(f.ctx)
      await driver.step(signal)
      expect((await driver.step(signal)).outcome).toBe('parked')
      driver = await factory.resume(f.ctx, f.checkpoint())
      if (status === 'E_LANE_BUSY' || status === 'PARKED') f.failResume(status)
      else f.resume(status)
      const result = await driver.step(signal)
      expect(result.outcome).toBe(
        status === 'opened' ? 'running' : status === 'blocked' ? 'turn-ended' : 'parked',
      )
      if (status !== 'opened') expect(f.effects).toEqual([])
      f.failResume('')
      f.resume('opened')
      if (status !== 'opened') expect((await driver.step(signal)).phase).toBe('action')
      const committed = f.checkpoint()
      const resumedCall = f.checkpoints.find((checkpoint) => {
        const saved = state(checkpoint)
        return saved.approvalCall && !saved.approvalWaiting && !saved.pending
      })
      if (!resumedCall) throw new Error('Missing receipt continuation checkpoint')
      // Reopen between receipt reconnect and the stage's next checkpoint.
      const interrupted = await factory.resume(f.ctx, resumedCall)
      expect((await interrupted.step(signal)).phase).toBe('action')
      driver = await factory.resume(f.ctx, committed)
      expect((await driver.step(signal)).reason).toBe('completed')
      expect(f.effects).toEqual([
        expect.objectContaining({ name: 'business-write', invocationId: expect.any(String) }),
      ])
    },
  )

  it('passes a stage tool call option through to the loop port', async () => {
    const f = fixture()
    await withModel(f)
    const seen: unknown[] = []
    const execute = f.ctx.tools.execute
    f.ctx.tools.execute = async (call, callSignal, options) => {
      if (call.name.startsWith('business')) seen.push({ name: call.name, options })
      return execute(call, callSignal)
    }
    const { factory } = definition({
      stages: [
        {
          name: 'read',
          async run(ctx, _state, stageSignal) {
            await ctx.tools.execute({ name: 'business-read', args: {} }, stageSignal, { announce: true })
            return { read: true }
          },
        },
        {
          name: 'write',
          approval: true,
          async run(ctx, _state, stageSignal) {
            const announce = { content: [{ type: 'text' as const, text: 'writing' }] }
            await ctx.tools.execute({ name: 'business-write', args: {} }, stageSignal, { announce })
            return { written: true }
          },
        },
      ],
    })
    const driver = await factory.create(f.ctx)
    for (let i = 0; i < 10 && f.finishes.length === 0; i++) await driver.step(signal)
    expect(f.finishes).toEqual(['completed'])
    expect(seen).toEqual([
      { name: 'business-read', options: { announce: true } },
      { name: 'business-write', options: { announce: { content: [{ type: 'text', text: 'writing' }] } } },
    ])
  })

  it('refuses stop during approval park and refuses uncertain stage replay', async () => {
    const f = fixture()
    await withModel(f)
    f.park('business-write')
    const { factory } = definition({
      stages: [
        {
          name: 'action',
          approval: true,
          async run(ctx, _state, signal) {
            await ctx.tools.execute({ name: 'business-write', args: {} }, signal)
            return { recorded: true }
          },
        },
      ],
    })
    const driver = await factory.create(f.ctx)
    await driver.step(signal)
    await driver.step(signal)
    await driver.cancel()
    expect((await driver.step(signal)).reason).toBe('aborted')
    f.stop()
    const cold = await factory.resume(f.ctx, f.checkpoint())
    expect((await cold.step(signal)).reason).toBe('aborted')
    expect(f.effects).toEqual([])
    const pending = structuredClone(f.checkpoint())
    if (pending.state && typeof pending.state === 'object' && !Array.isArray(pending.state))
      pending.state.approvalWaiting = false
    const fresh = fixture()
    fresh.inputs.push(input('reconcile'))
    const unknown = await factory.resume(fresh.ctx, pending)
    expect(await unknown.step(signal)).toMatchObject({
      outcome: 'turn-ended',
      phase: 'unknown',
      reason: 'blocked',
    })
    expect(fresh.calls).toEqual([])
  })

  it.each(['Proceed', 'Cancel'])(
    'consumes only matching authenticated structured surface receipts: %s',
    async (answer) => {
      const f = fixture()
      await withModel(f)
      const { factory } = definition({
        confirm: 'surface',
        stages: [
          {
            name: 'action',
            confirm: () => 'Record?',
            async run() {
              return { recorded: true }
            },
          },
        ],
      })
      let driver = await factory.create(f.ctx)
      await driver.step(signal)
      await driver.step(signal)
      // Core accepts a fresh input into a model continuation. Yield that admission so a
      // deferred UI invocation can drain before its wake input is classified as an answer.
      f.ctx.input.accept = async () => {
        const next = f.inputs.shift() ?? null
        if (next) f.continuation('model')
        return next
      }
      for (const receipt of [
        input('text', 'Proceed'),
        { ...input('forged'), origin: 'principal' as const },
        {
          ...input('wrong'),
          origin: 'system' as const,
          system: { source: 'another', type: 'action-result', summary: 'Proceed', data: {} },
        },
      ]) {
        f.continuation(null)
        f.inputs.push(receipt)
        expect((await driver.step(signal)).outcome).toBe('running')
        expect(state(f.checkpoint()).data).not.toHaveProperty('recorded')
        expect((await driver.step(signal)).outcome).toBe('parked')
      }
      f.continuation('checkpoint')
      f.inputs.push(input('unrelated-notification'))
      f.inputs.push({
        ...input('answer', 'The summary is not an answer'),
        origin: 'system',
        system: {
          source: 'agnes/intelligent-ui',
          type: 'action-result',
          summary: 'display only',
          data: {
            status: 'succeeded',
            surfaceId: 'question',
            invocation: { tool: 'ui_submit' },
            submitted: { answers: { proceed: answer } },
          },
        },
      })
      driver = await factory.resume(f.ctx, f.checkpoint())
      expect((await driver.step(signal)).outcome).toBe('running')
      expect((await driver.step(signal)).outcome).toBe(answer === 'Proceed' ? 'running' : 'turn-ended')
      expect(state(f.checkpoint()).data).toMatchObject(answer === 'Proceed' ? { recorded: true } : {})
      if (answer === 'Cancel') expect(state(f.checkpoint()).data).not.toHaveProperty('recorded')
    },
  )

  it('checkpoints generic system inputs before a boundary can consume them', async () => {
    const f = fixture()
    const { factory } = definition({
      stages: ['child-1', 'child-2'].map((id) => ({
        name: `await-${id}`,
        inputStage: true,
        async run(_ctx, state) {
          const notice = state.stageInput?.system
          return notice?.source === 'agnes/child' && notice.type === 'child-completed'
            ? { [id]: notice.data }
            : { waitingForInput: true }
        },
      })),
    })
    let driver = await factory.create(f.ctx)
    await driver.step(signal)
    expect((await driver.step(signal)).outcome).toBe('parked')
    f.inputs.push(input('unrelated'))
    expect((await driver.step(signal)).phase).toBe('waiting-for-action')
    expect((await driver.step(signal)).outcome).toBe('parked')
    f.continuation('checkpoint')
    f.inputs.push({
      ...input('child', ''),
      origin: 'system',
      system: {
        source: 'agnes/child',
        type: 'child-completed',
        summary: 'Child finished',
        data: { childKey: 'child-1', status: 'completed' },
      },
    })
    f.inputs.push({
      ...input('child-next', ''),
      origin: 'system',
      system: {
        source: 'agnes/child',
        type: 'child-completed',
        summary: 'Next child finished',
        data: { childKey: 'child-2', status: 'completed' },
      },
    })
    expect((await driver.step(signal)).phase).toBe('await-child-1')
    driver = await factory.resume(f.ctx, f.checkpoint())
    expect(state(driver.checkpoint()).data).toMatchObject({
      'child-1': { childKey: 'child-1', status: 'completed' },
    })
    expect((await driver.step(signal)).phase).toBe('await-child-2')
    expect(state(driver.checkpoint()).data).toMatchObject({
      'child-2': { childKey: 'child-2', status: 'completed' },
    })
    expect((await driver.step(signal)).reason).toBe('completed')
  })

  it('rejects incompatible and broken scheduling checkpoints and unsafe output directories', async () => {
    const f = fixture()
    const { factory } = definition()
    const driver = await factory.create(f.ctx)
    await driver.step(signal)
    for (const patch of [
      { pending: false, approvalWaiting: true },
      { index: 99 },
      { waiting: {} },
      { stageInput: {} },
      { completed: true },
    ]) {
      const checkpoint = { ...driver.checkpoint(), state: { ...state(driver.checkpoint()), ...patch } }
      expect(() => factory.resume(f.ctx, checkpoint)).toThrow(/Invalid/)
    }
    expect(() => factory.resume(f.ctx, { codecVersion: 4, state: {} })).toThrow(/unsupported/)
    expect(() => definition({ deliverables: { directory: '../source' } })).toThrow(/relative path/)
  })
})

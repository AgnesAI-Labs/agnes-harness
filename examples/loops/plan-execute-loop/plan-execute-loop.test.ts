import { readFileSync } from 'node:fs'
import type { LoopCheckpoint } from '@agnes/extension-api'
import { driveLoop, scriptedDecisions } from '@agnes/plugin-runtime/testkit'
import { describe, expect, it } from 'vitest'
import { codec, createPlanExecuteLoop } from './index.mjs'

const plan = [
  { tool: 'read', args: { path: 'a' } },
  { tool: 'spawn', args: { task: 'b' }, awaitChild: true },
  { tool: 'write', args: { path: 'c' } },
]
const reply = (steps: unknown) => [{ type: 'text_delta' as const, delta: JSON.stringify(steps) }]
const turnView = {
  turnId: 1,
  step: 0,
  cancelled: false,
  history: [],
  tools: ['read', 'spawn', 'write'].map((name) => ({
    name,
    description: name,
    parameters: { type: 'object' },
  })),
  model: { slot: 'primary', id: 'scripted', capabilities: null },
  prompt: { sections: [], runtime: {} },
  budget: { maxSteps: null, stepsUsed: 0, creditsUsed: 0, perRequestCap: null, onExceed: 'quote' },
} as never
const prompt = { content: [{ type: 'text' as const, text: 'do the work' }] }
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const notice = (status: string) => ({
  content: [{ type: 'text' as const, text: 'child done' }],
  origin: 'system' as const,
  target: 'next-step' as const,
  system: {
    source: 'agnes/child',
    type: 'child-completed',
    data: { childKey: 'child-1', status },
    summary: 'child finished',
  },
})
const tools = (log: string[] = []) => ({
  execute: async (call: { name: string }) => {
    log.push(call.name)
    return ok(`${call.name} ok`)
  },
  batch: async () => {
    throw new Error('plan-execute runs steps one at a time')
  },
})

async function approved(extra: Record<string, unknown> = {}) {
  const decisions = scriptedDecisions()
  const factory = createPlanExecuteLoop()
  const first = await driveLoop(factory, {
    replies: [reply(plan)],
    inputs: [prompt],
    decisions: decisions.port,
    turnView,
  })
  decisions.answer('plan:1', 'approve')
  return {
    decisions,
    factory,
    first,
    options: { decisions: decisions.port, turnView, checkpoint: first.checkpoint, turnOpen: true, ...extra },
  }
}

describe('plan-execute loop through the generic ports', () => {
  it('plans, parks on one decision, then executes and waits for the child notice', async () => {
    const log: string[] = []
    const { decisions, factory, first, options } = await approved()
    expect(first.steps.at(-1)).toMatchObject({ outcome: 'parked' })
    expect(decisions.requests).toHaveLength(1)
    expect(decisions.requests[0]).toMatchObject({ key: 'plan:1', options: ['approve', 'reject'] })
    // The child notice arrives while the loop waits at step 1; it lets the plan continue.
    const second = await driveLoop(factory, {
      ...options,
      inputs: [notice('completed')],
      tools: tools(log),
      until: 'turn-end',
    })
    expect(log).toEqual(['read', 'spawn', 'write'])
    expect(second.finished).toEqual(['completed', undefined])
    expect(second.events.map((event) => event.type)).toContain('notice')
    expect(second.events.at(-1)).toMatchObject({ type: 'assistant/message' })
  })

  it('finishes blocked when the person rejects, without running any tool', async () => {
    const decisions = scriptedDecisions()
    const factory = createPlanExecuteLoop()
    const first = await driveLoop(factory, {
      replies: [reply(plan)],
      inputs: [prompt],
      decisions: decisions.port,
      turnView,
    })
    decisions.answer('plan:1', 'reject')
    const log: string[] = []
    const second = await driveLoop(factory, {
      decisions: decisions.port,
      turnView,
      checkpoint: first.checkpoint,
      tools: tools(log),
    })
    expect(log).toEqual([])
    expect(second.finished?.[0]).toBe('blocked')
  })

  it('finishes blocked when the approval expires', async () => {
    const decisions = scriptedDecisions()
    const factory = createPlanExecuteLoop()
    const first = await driveLoop(factory, {
      replies: [reply(plan)],
      inputs: [prompt],
      decisions: decisions.port,
      turnView,
    })
    decisions.expire('plan:1')
    const second = await driveLoop(factory, {
      decisions: decisions.port,
      turnView,
      checkpoint: first.checkpoint,
      tools: tools(),
    })
    expect(second.finished?.[0]).toBe('blocked')
  })

  it('ends the plan when a child did not complete', async () => {
    const { factory, options } = await approved()
    const log: string[] = []
    const run = await driveLoop(factory, { ...options, inputs: [notice('failed')], tools: tools(log) })
    expect(run.finished?.[0]).toBe('blocked')
    expect(run.finished?.[1]).toMatchObject({ code: 'PLAN_CHILD_NOT_COMPLETED' })
  })

  it('refuses to replay a step whose outcome is unknown', async () => {
    const { factory, options } = await approved({
      effects: {
        'plan:1:step:0': { status: 'may-have-sent', invocationId: 'plan:1:step:0', checkpoint: null },
      },
    })
    const log: string[] = []
    const run = await driveLoop(factory, { ...options, tools: tools(log) })
    expect(log).toEqual([])
    expect(run.finished?.[0]).toBe('error')
    expect(run.finished?.[1]).toMatchObject({ code: 'PLAN_UNKNOWN_OUTCOME' })
  })

  it('reuses a durable receipt instead of re-executing', async () => {
    const { factory, options } = await approved({
      effects: {
        'plan:1:step:0': {
          status: 'responded',
          invocationId: 'plan:1:step:0',
          checkpoint: null,
          result: ok('cached'),
        },
      },
    })
    const log: string[] = []
    await driveLoop(factory, { ...options, tools: tools(log), inputs: [notice('completed')] })
    expect(log[0]).toBe('spawn')
  })

  it('ends as error with the failing step when a tool fails', async () => {
    const { factory, options } = await approved()
    const run = await driveLoop(factory, {
      ...options,
      tools: { ...tools(), execute: async () => ({ ...ok('boom'), isError: true }) },
    })
    expect(run.finished?.[1]).toMatchObject({ code: 'PLAN_STEP_FAILED' })
  })

  it('parks on an approval-bound tool and resumes only the original call', async () => {
    const { factory, options } = await approved()
    const parked = await driveLoop(factory, {
      ...options,
      tools: {
        ...tools(),
        execute: async () => {
          throw Object.assign(new Error('parked'), { code: 'PARKED' })
        },
      },
    })
    expect(parked.steps.at(-1)).toMatchObject({ outcome: 'parked' })
    const resumed: string[] = []
    const run = await driveLoop(factory, {
      ...options,
      checkpoint: parked.checkpoint,
      resumeParked: 'opened',
      inputs: [notice('completed')],
      tools: {
        ...tools(),
        resume: async (id) => {
          resumed.push(id)
          return ok('approved read')
        },
      },
    })
    expect(resumed).toEqual(['plan:1:step:0'])
    expect(run.finished?.[0]).toBe('completed')
  })

  it.each([
    ['not JSON', 'sure, here you go'],
    ['unknown tool', JSON.stringify([{ tool: 'rm', args: {} }])],
    ['empty plan', '[]'],
  ])('finishes honestly on an invalid plan: %s', async (_name, delta) => {
    const run = await driveLoop(createPlanExecuteLoop(), {
      replies: [[{ type: 'text_delta', delta }]],
      inputs: [prompt],
      turnView,
    })
    expect(run.finished?.[1]).toMatchObject({ code: 'PLAN_INVALID' })
  })

  it('answers a stray child notice with no plan waiting, doing nothing', async () => {
    const { target: _target, ...stray } = notice('completed')
    const run = await driveLoop(createPlanExecuteLoop(), { inputs: [stray] })
    expect(run.finished?.[0]).toBe('completed')
    expect(run.events.map((event) => event.type)).toEqual(['notice'])
  })

  it('rejects an unsupported checkpoint codec before resumed work', () => {
    const bad: LoopCheckpoint = { codecVersion: 99, state: {} }
    expect(() => codec.decode(bad)).toThrow(/unsupported/)
  })
})

describe('conformance: generic surface only', () => {
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  it('uses no default-loop convenience port', () => {
    for (const forbidden of [
      /\bcontinuation\b/,
      /\.respond\(/,
      /\.drain\(/,
      /finishCancelled/,
      /finishFailure/,
      /turn\.checkpoint\(/,
      /wait\.poll\(/,
      /LoopContinuation/,
    ])
      expect(source).not.toMatch(forbidden)
  })
  it('imports only the public extension API', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    expect(imports).toEqual(['@agnes/extension-api'])
  })
})

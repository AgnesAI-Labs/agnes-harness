import { readFileSync } from 'node:fs'
import { checkManifest, type ExtensionAPI, type HookContext, type HookHandler } from '@agnes/extension-api'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import goalExtension from '../src/index.js'
import { CONTINUE_PREFIX, type GoalState, goalProjection } from '../src/state.js'

function goalRef(state: GoalState) {
  if (!state.goal) throw new Error('missing goal')
  return { id: state.goal.id, revision: state.goal.revision }
}
let seq = 0
const event = (type: string, data: EventEnvelope['data'], automatic = false): EventEnvelope => ({
  seq: ++seq,
  id: `e-${seq}`,
  ts: '2026-01-01T00:00:00.000Z',
  type,
  data,
  actor: {
    id: automatic ? 'agnes/goal' : 'user',
    role: automatic ? 'extension' : 'user',
    org: 'local',
    deptPath: [],
    attrs: {},
  },
  origin: 'system',
  trust: 'trusted',
})
const input = (state: GoalState, text: string, automatic = false) =>
  goalProjection.apply(
    state,
    event(
      'user/message',
      { content: [{ type: 'text', text }], kind: automatic ? 'follow_up' : 'prompt' },
      automatic,
    ),
  )

describe('ledger goal state', () => {
  it('replays all human lifecycle controls and refuses invalid changes', () => {
    expect(
      checkManifest(JSON.parse(readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'))).ok,
    ).toBe(true)
    let state = input(goalProjection.init(), '/goal create --max-rounds 3 --budget 5 Ship a release')
    expect(state.goal).toMatchObject({
      phase: 'active',
      objective: 'Ship a release',
      maxRounds: 3,
      budgetCredits: 5,
    })
    const original = state.goal
    const viewed = input(state, '/goal show')
    expect(goalProjection.apply(viewed, event('turn/end', { reason: 'blocked' })).goal).toEqual(original)
    for (const line of [
      '/goal create Replace it',
      '/goal edit --max-rounds 0 invalid',
      '/goal edit --budget NaN invalid',
    ])
      expect(input(state, line)).toMatchObject({
        goal: original,
        input: { run: false, error: expect.any(String) },
      })
    state = input(state, '/goal pause')
    expect(state.goal?.phase).toBe('paused')
    state = input(state, '/goal edit --max-rounds 2 Ship a patch')
    expect(state.goal).toMatchObject({ phase: 'paused', objective: 'Ship a patch', maxRounds: 2 })
    state = input(state, '/goal edit --budget none Ship a patch')
    expect(state.goal?.budgetCredits).toBeUndefined()
    state = input(state, '/goal resume')
    expect(state.goal).toMatchObject({ phase: 'active', rounds: 0 })
    state = input(state, '/goal complete')
    expect(input(state, '/goal resume').input?.error).toBeTruthy()
    expect(input(state, '/goal pause').goal?.phase).toBe('complete')
    expect(input(state, '/goal clear').goal).toBeNull()
    expect(input(goalProjection.init(), '/goal pause').input?.error).toBeTruthy()
  })

  it('accepts only reserved automatic rounds for the current goal revision and stops on failure', () => {
    let state = input(goalProjection.init(), '/goal --max-rounds 1 Finish')
    const ref = { id: goalRef(state).id, revision: goalRef(state).revision, round: 1 }
    const text = CONTINUE_PREFIX + JSON.stringify(ref)
    expect(input(state, text, true).input?.run).toBe(false)
    state = goalProjection.apply(state, event('x/agnes/goal/reserved', { ...ref, turn: 1 }))
    const accepted = input(state, text, true)
    expect(accepted.goal?.rounds).toBe(1)
    expect(input(accepted, text, true).input?.run).toBe(false)
    const pausedInbox = goalProjection.apply(
      state,
      event('inbox', {
        items: [{ actor: { role: 'owner' }, content: [{ type: 'text', text: '/goal pause' }] }],
      }),
    )
    expect(pausedInbox.goal?.phase).toBe('paused')
    expect(input(pausedInbox, text, true).input?.run).toBe(false)
    for (const op of ['pause', 'clear', 'edit Changed'])
      expect(input(input(state, `/goal ${op}`), text, true).input?.run).toBe(false)
    for (const reason of ['aborted', 'error', 'budget', 'max_steps', 'blocked'])
      expect(goalProjection.apply(accepted, event('turn/end', { reason })).goal).toMatchObject({
        phase: 'blocked',
        reason: `Turn stopped: ${reason}`,
      })
    const restored = goalProjection.apply(state, event('x/agnes/goal/paused', {}))
    expect(restored.goal?.phase).toBe('paused')
    expect(input(restored, text, true).input?.run).toBe(false)
  })

  it('retains spend, completion evidence and blockers across projections and resume', () => {
    let state = input(goalProjection.init(), '/goal --budget 2 Work')
    expect(goalProjection.apply(state, event('cost/ledger', { creditSource: 'unknown' })).goal).toMatchObject(
      { phase: 'blocked', reason: 'Credit usage unavailable' },
    )
    expect(goalProjection.apply(state, event('cost/ledger', { credits: 0 }))).toBe(state)
    state = goalProjection.apply(state, event('cost/ledger', { credits: 1.5 }))
    state = goalProjection.apply(state, event('cost/ledger', { adjustment: { delta: -0.5 } }))
    expect(state.goal?.creditsUsed).toBe(1)
    const ref = { id: goalRef(state).id, revision: goalRef(state).revision }
    expect(
      goalProjection.apply(state, event('x/agnes/goal/updated', { ...ref, phase: 'blocked', reason: ' ' })),
    ).toEqual(state)
    state = goalProjection.apply(
      state,
      event('x/agnes/goal/updated', { ...ref, phase: 'blocked', reason: 'Need credentials' }),
    )
    expect(state.goal).toMatchObject({ phase: 'blocked', reason: 'Need credentials', creditsUsed: 1 })
    state = input(state, '/goal resume')
    expect(state.goal).toMatchObject({ phase: 'active', creditsUsed: 1 })
    expect(state.goal?.reason).toBeUndefined()
    state = goalProjection.apply(
      state,
      event('x/agnes/goal/updated', {
        id: goalRef(state).id,
        revision: goalRef(state).revision,
        phase: 'complete',
        reason: 'Validated result',
      }),
    )
    expect(state.goal).toMatchObject({ phase: 'complete', reason: 'Validated result' })
  })
})

it('blocks exhausted budgets and unavailable continuation through the public hooks', async () => {
  let state = input(goalProjection.init(), '/goal --budget 2 Finish')
  const hooks: { before_step?: HookHandler<'before_step'>; turn_stopping?: HookHandler<'turn_stopping'> } = {}
  const noop = () => () => undefined
  const api = {
    ctx: { signal: new AbortController().signal },
    registerProjection: noop,
    registerTool: noop,
    registerSlot: noop,
    registerHook: (event: string, handler: unknown) => {
      Object.assign(hooks, { [event]: handler })
      return () => undefined
    },
    events: {
      append: async (name: string, data: EventEnvelope['data']) => {
        const row = event(`x/agnes/goal/${name}`, data)
        state = goalProjection.apply(state, row)
        return row.seq
      },
    },
  } as unknown as ExtensionAPI
  await goalExtension(api)
  const ctx = {
    signal: new AbortController().signal,
    projections: {
      readOwn: async () => ({ status: 'available', value: state, asOfSeq: seq, stateVersion: 1 }),
    },
  } as unknown as HookContext
  if (!hooks.before_step || !hooks.turn_stopping) throw new Error('missing goal hooks')
  state = goalProjection.apply(state, event('cost/ledger', { credits: 2 }))
  expect(
    await hooks.before_step({ turn: 1, step: 2, budget: { remaining: 10, cap: null }, depth: 0 }, ctx),
  ).toMatchObject({ park: true, reason: 'Goal credit budget exhausted' })
  expect(state.goal).toMatchObject({ phase: 'blocked', reason: 'Credit budget exhausted' })
  state = input(state, '/goal clear')
  state = input(state, '/goal Finish')
  state = input(state, '/goal show')
  expect(await hooks.turn_stopping({ turn: 2, step: 1, proposedReason: 'completed' }, ctx)).toEqual({
    action: 'stop',
  })
  expect(state.goal?.phase).toBe('active')
  state = input(state, '/goal edit Finish')
  expect(await hooks.turn_stopping({ turn: 2, step: 1, proposedReason: 'completed' }, ctx)).toEqual({
    action: 'stop',
  })
  expect(state.goal).toMatchObject({
    phase: 'blocked',
    reason: 'Automatic continuation unavailable on this host',
  })
})

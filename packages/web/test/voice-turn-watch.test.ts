import type { UINode, UITurn } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { TurnWatch } from '../src/voice/turn-watch.js'

const scope = { sessionId: 's1', epoch: 1 }
const ZERO_USAGE: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}

function turn(
  id: string,
  status: UITurn['status'],
  finalAssistantId?: string,
  extra: Partial<UITurn> = {},
): UITurn {
  return {
    id,
    turn: Number(id.slice(1)),
    startSeq: 1,
    startedAt: '2026-10-27T00:00:00.000Z',
    status,
    nodeIds: finalAssistantId ? [finalAssistantId] : [],
    usage: ZERO_USAGE,
    inherited: false,
    forkable: true,
    ...(finalAssistantId ? { finalAssistantId } : {}),
    ...extra,
  }
}

function assistant(id: string, text: string, streaming = false): UINode {
  return { kind: 'assistant', id, seq: 2, text, ...(streaming ? { streaming } : {}) } as UINode
}

describe('TurnWatch', () => {
  it('never reports on history load', () => {
    const w = new TurnWatch()
    expect(w.observe(scope, [assistant('n1', '旧')], [turn('t1', 'completed', 'n1')])).toBeUndefined()
    expect(w.observe(scope, [assistant('n1', '旧')], [turn('t1', 'completed', 'n1')])).toBeUndefined()
  })

  it('reports the reply once when the viewed turn completes', () => {
    const w = new TurnWatch()
    expect(w.observe(scope, [], [turn('t2', 'running')])).toBeUndefined()
    const nodes = [assistant('n2', '答')]
    const done = [turn('t2', 'completed', 'n2')]
    expect(w.observe(scope, nodes, done)).toEqual({ kind: 'reply', turnId: 't2', nodeId: 'n2', text: '答' })
    expect(w.observe(scope, nodes, done)).toBeUndefined()
    expect(w.observe(scope, nodes, [turn('t2', 'completed', 'n2', { durationMs: 5 })])).toBeUndefined()
  })

  it('ignores cost-only updates', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    const nodes = [assistant('n2', '答')]
    expect(w.observe(scope, nodes, [turn('t2', 'completed', 'n2')])).toMatchObject({ kind: 'reply' })
    const usage = { ...ZERO_USAGE, totals: { ...ZERO_USAGE.totals, input: 5, output: 5 } }
    expect(w.observe(scope, nodes, [turn('t2', 'completed', 'n2', { usage })])).toBeUndefined()
  })

  it('ignores updates that leave the signature unchanged while running', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    expect(w.observe(scope, [assistant('n2', '半', true)], [turn('t2', 'running', 'n2')])).toBeUndefined()
    expect(w.observe(scope, [assistant('n2', '半句', true)], [turn('t2', 'running', 'n2')])).toBeUndefined()
  })

  it('waits for the final node to stop streaming', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    const done = [turn('t2', 'completed', 'n2')]
    expect(w.observe(scope, [assistant('n2', '答', true)], done)).toBeUndefined()
    expect(w.observe(scope, [assistant('n2', '答案', false)], done)).toEqual({
      kind: 'reply',
      turnId: 't2',
      nodeId: 'n2',
      text: '答案',
    })
  })

  it('does not report a turn completed before a reconnect', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    const nodes = [assistant('n2', '答')]
    const done = [turn('t2', 'completed', 'n2')]
    expect(w.observe({ sessionId: 's1', epoch: 2 }, nodes, done)).toBeUndefined()
    expect(w.observe({ sessionId: 's1', epoch: 2 }, nodes, done)).toBeUndefined()
  })

  it('treats a new session id as a new baseline', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    expect(
      w.observe({ sessionId: 's2', epoch: 1 }, [assistant('n9', '别')], [turn('t9', 'completed', 'n9')]),
    ).toBeUndefined()
  })

  it('reports no-reply for a failed or cancelled turn', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    expect(w.observe(scope, [], [turn('t2', 'failed')])).toMatchObject({
      kind: 'no-reply',
      turnId: 't2',
      status: 'failed',
    })
    expect(w.observe(scope, [], [turn('t2', 'failed')])).toBeUndefined()
    w.observe(scope, [], [turn('t3', 'waiting')])
    expect(w.observe(scope, [], [turn('t3', 'cancelled')])).toMatchObject({
      kind: 'no-reply',
      turnId: 't3',
      status: 'cancelled',
    })
  })

  it('reports no-reply for a completed turn without a settled non-empty final answer', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    expect(w.observe(scope, [assistant('n2', '  \n')], [turn('t2', 'completed', 'n2')])).toMatchObject({
      kind: 'no-reply',
      status: 'completed',
    })
    w.observe(scope, [], [turn('t3', 'running')])
    expect(w.observe(scope, [], [turn('t3', 'completed')])).toMatchObject({ kind: 'no-reply', turnId: 't3' })
  })

  it('counts a new turn first seen as completed as busy', () => {
    const w = new TurnWatch()
    expect(w.observe(scope, [], [])).toBeUndefined()
    expect(w.observe(scope, [assistant('n1', '快')], [turn('t1', 'completed', 'n1')])).toEqual({
      kind: 'reply',
      turnId: 't1',
      nodeId: 'n1',
      text: '快',
    })
    expect(
      w.observe(
        scope,
        [assistant('n1', '快'), assistant('n2', '又')],
        [turn('t1', 'completed', 'n1'), turn('t2', 'completed', 'n2')],
      ),
    ).toMatchObject({
      kind: 'reply',
      turnId: 't2',
    })
  })

  it('stays silent again after reset', () => {
    const w = new TurnWatch()
    w.observe(scope, [], [turn('t2', 'running')])
    w.reset()
    expect(w.observe(scope, [assistant('n2', '答')], [turn('t2', 'completed', 'n2')])).toBeUndefined()
  })
})

// @vitest-environment happy-dom

import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { buildTraceRows, placeTraceRowsInTurns } from '../src/trace-model.js'

afterEach(() => {
  document.documentElement.lang = ''
})

const at = '2026-10-14T08:57:28.000Z'
const turn = (n: number, startSeq: number, nodeIds: string[], children: UISpan[] = [], endSeq?: number) =>
  ({
    id: `turn:${n}`,
    turn: n,
    startSeq,
    ...(endSeq ? { endSeq } : {}),
    startedAt: at,
    status: 'completed',
    nodeIds,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
    trace: {
      id: `turn:${n}`,
      kind: 'turn',
      name: `Turn ${n}`,
      status: 'completed',
      startSeq,
      startedAt: at,
      children,
    },
  }) as UITurn
const uiFact = (seq: number, name: string): UISpan => ({
  id: `ui-fact:${seq}`,
  kind: 'other',
  name,
  status: 'completed',
  startSeq: seq,
  endSeq: seq,
  startedAt: at,
  children: [],
})
const tool = (id: string, seq: number, name: string, extra: Partial<UINode> = {}): UINode =>
  ({
    kind: 'tool',
    id,
    seq,
    toolUseId: `call-${id}`,
    name,
    status: 'completed',
    summary: name,
    children: [],
    ...extra,
  }) as UINode

const deferred: UINode = {
  kind: 'user',
  id: 'deferred',
  seq: 20,
  origin: 'system',
  content: [
    { type: 'text', text: 'A deferred tool invocation is queued. Execute only its durable backend binding.' },
  ],
  system: {
    source: 'agnes/deferred-invocations',
    type: 'invocation-queued',
    summary: 'A deferred tool invocation is queued. Execute only its durable backend binding.',
    data: { invocationId: 'ui:abc' },
  },
}
const answers: UINode = {
  kind: 'user',
  id: 'answers',
  seq: 27,
  origin: 'system',
  content: [{ type: 'text', text: 'UI submit succeeded: Submit' }],
  system: {
    source: 'agnes/intelligent-ui',
    type: 'action-result',
    summary: 'UI submit succeeded: Submit',
    data: { status: 'succeeded', submitted: { surfaceId: 'card-q', answers: { a: 1, b: 2, c: 3, d: 4 } } },
    presentation: {
      kind: 'ui-action',
      operation: 'submit',
      status: 'succeeded',
      label: 'Submit',
      fields: [],
    },
  },
}

describe('trace turn placement', () => {
  it('keeps every turn in one run when UI facts carry an older turn number', () => {
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '帮我创建一个靴子门户网站' }] },
      { kind: 'assistant', id: 'a1', seq: 3, text: 'Let me ask.' },
      tool('ask', 4, 'ask_user_question'),
      deferred,
      tool('submit', 23, 'ui_submit'),
      answers,
      { kind: 'assistant', id: 'a2', seq: 30, text: 'Building.' },
    ]
    // The host records the UI facts under turn 1 (the task id taken when the action arrived).
    const turns = [
      turn(
        1,
        2,
        ['u1', 'a1', 'ask'],
        [
          uiFact(5, 'surface.opened · r1 · Questions'),
          uiFact(19, 'action.received · r1'),
          uiFact(22, 'action.executing · r1'),
          uiFact(25, 'action.succeeded · r1'),
          uiFact(26, 'surface.closed · r1 · Questions'),
        ],
        10,
      ),
      turn(2, 21, ['deferred', 'submit', 'answers', 'a2']),
    ]
    const rows = placeTraceRowsInTurns(buildTraceRows(nodes, turns), turns)
    const sequence = rows.map((row) => row.turn)
    expect(sequence).toEqual([...sequence].sort((a, b) => (a ?? 0) - (b ?? 0)))
    const runs = sequence.filter((value, index) => index === 0 || sequence[index - 1] !== value)
    expect(runs).toEqual([1, 2])
    // An action answered after turn 1 ended stays with turn 1 as one row with each recorded state.
    const action = rows.find((row) => row.id === 'ui-fact:19')
    expect(action?.turn).toBe(1)
    expect(action?.steps?.map((step) => step.label)).toEqual([
      'Action received',
      'Action executing',
      'Action succeeded',
    ])
    expect(rows.find((row) => row.id === 'ui-fact:26')?.turn).toBe(2)
  })

  it('keeps recorded turns when no turn owns the position', () => {
    const nodes: UINode[] = [{ kind: 'assistant', id: 'a', seq: 1, text: 'x' }]
    const rows = buildTraceRows(nodes, [])
    expect(placeTraceRowsInTurns(rows, [])).toEqual(rows)
  })
})

describe('platform-written inputs', () => {
  it('shows a business-UI answer as your action and a deferred wake-up as a system record', () => {
    document.documentElement.lang = 'zh-CN'
    const rows = buildTraceRows([deferred, answers], [turn(1, 1, ['deferred', 'answers'])])
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('answers')).toMatchObject({
      kind: 'control',
      badge: '你的操作',
      preview: '提交了 4 个回答',
    })
    expect(byId.get('deferred')).toMatchObject({ kind: 'context', preview: '后台工具调用已排队，等待执行' })
    for (const row of rows) {
      expect(row.badge).not.toBe('用户')
      expect(row.preview).not.toMatch(/deferred tool invocation|UI submit succeeded/)
    }
  })

  it('keeps a typed message as the user', () => {
    const rows = buildTraceRows(
      [{ kind: 'user', id: 'u', seq: 1, origin: 'principal', content: [{ type: 'text', text: 'hi' }] }],
      [],
    )
    expect(rows[0]).toMatchObject({ kind: 'user', preview: 'hi' })
  })
})

describe('failed tools', () => {
  it('carries the recorded error onto the row', () => {
    const failedSpan: UISpan = {
      id: 'span:tool:x',
      kind: 'tool',
      name: 'bash',
      status: 'failed',
      startSeq: 2,
      startedAt: at,
      durationMs: 26,
      toolUseId: 'call-x',
      error: { code: 'TOOL_FAILED', message: 'npx: command not found' },
      children: [],
    }
    const rows = buildTraceRows(
      [tool('x', 2, 'bash', { status: 'failed', resultPreview: 'exit 127' })],
      [turn(1, 1, ['x'], [failedSpan])],
    )
    expect(rows[0]).toMatchObject({ errorCode: 'TOOL_FAILED', errorMessage: 'npx: command not found' })
    const noSpan = buildTraceRows([tool('y', 2, 'bash', { status: 'failed', resultPreview: 'exit 127' })], [])
    expect(noSpan[0]?.errorMessage).toBe('exit 127')
  })
})

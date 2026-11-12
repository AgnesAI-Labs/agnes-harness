import type { ProjectionEvent } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { createConversationProjection } from '../src/uses/conversation-projection.js'

export const human = { id: 'alice', org: 'test', role: 'user', deptPath: [], attrs: {} }
export function event(seq: number, type: string, data: unknown, extra: object = {}): ProjectionEvent {
  return {
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    id: `event-${seq}`,
    type,
    data,
    actor: human,
    origin: 'principal',
    trust: 'trusted',
    ...extra,
  } as ProjectionEvent
}
const content = (text: string) => [{ type: 'text', text }]
export const prompt = (seq: number, text: string, extra: object = {}) =>
  event(seq, 'user/message', { content: content(text), kind: 'prompt' }, extra)
const projection = () => createConversationProjection('plugin/test')
it('keeps the latest genuine prompt and final text, using real tool-use stop reasons', () => {
  const p = projection()
  let s = p.apply(p.init(), prompt(1, 'task'))
  s = p.apply(
    s,
    event(2, 'assistant/message', {
      content: [...content('I will run it'), { type: 'thinking', text: 'private reasoning' }],
      stopReason: 'tool_use',
    }),
  )
  expect(s.request).toEqual({ seq: 1, text: 'task' })
  expect(s.reply).toEqual({ seq: 2, text: 'I will run it', hasTools: true })
  s = p.apply(
    s,
    event(3, 'user/message', { kind: 'runtime_context', content: content('reminder') }, { origin: 'system' }),
  )
  expect(s.request?.seq).toBe(1)
  s = p.apply(s, prompt(4, 'new task'))
  expect(s.reply).toBeNull()
})
it('does not treat extension follow-up or forged prompt as a human request', () => {
  const p = projection(),
    s = p.apply(p.init(), prompt(1, 'task'))
  for (const extra of [
    { origin: 'ext:other', actor: { ...human, role: 'extension' } },
    { origin: 'system' },
  ]) {
    expect(p.apply(s, prompt(2, 'fake', extra)).request?.seq).toBe(1)
  }
})
it('tracks conservative goal suppression through pause/complete/invalid commands until same actor clear', () => {
  const p = projection()
  let s = p.init()
  for (const text of ['/goal', '/goal show']) s = p.apply(s, prompt(1, text))
  expect(s.goalSources).toEqual([])
  for (const [i, text] of [
    '/goal create task',
    '/goal pause',
    '/goal complete',
    '/goal invalid',
    '/goal clear extra',
  ].entries())
    s = p.apply(s, prompt(i + 2, text))
  expect(s.goalSources).toHaveLength(1)
  s = p.apply(s, prompt(8, '/goal clear', { actor: { ...human, id: 'bob' } }))
  expect(s.goalSources).toHaveLength(1)
  s = p.apply(s, prompt(9, '/goal clear'))
  expect(s.goalSources).toEqual([])
})
it('ignores extension, runtime-context and system goal commands', () => {
  const p = projection(),
    initial = p.init()
  for (const extra of [
    { origin: 'ext:other', actor: { ...human, role: 'extension' } },
    { origin: 'system' },
    { trust: 'untrusted' },
  ])
    expect(p.apply(initial, prompt(1, '/goal create task', extra)).goalSources).toEqual([])
  expect(
    p.apply(
      initial,
      event(1, 'user/message', { kind: 'runtime_context', content: content('/goal create task') }),
    ).goalSources,
  ).toEqual([])
})
it('preserves inbox clear ordering across repeated snapshots, drain and delayed delivery', () => {
  const p = projection()
  const item = (id: string, text: string) => ({
    itemId: id,
    commandId: id,
    actor: human,
    origin: 'principal',
    trust: 'trusted',
    kind: 'prompt',
    content: content(text),
    target: 'next-turn',
    enqueuedAt: '',
  })
  const items = [item('create', '/goal create task'), item('clear', '/goal clear')]
  const rows = [
    event(1, 'inbox', { items }, { origin: 'system' }),
    event(2, 'inbox', { items }, { origin: 'system' }),
    event(3, 'inbox', null, { origin: 'system' }),
    event(4, 'user/message', { kind: 'prompt', commandId: 'create', content: items[0]!.content }),
    event(5, 'user/message', { kind: 'prompt', commandId: 'clear', content: items[1]!.content }),
  ]
  let s = p.init()
  for (const row of rows) {
    s = p.apply(s, row)
    expect(s.goalSources).toEqual([])
  }
  expect(rows.reduce(p.apply, p.init())).toEqual(s)
})
it('does not replay queued old create after a direct clear, including legacy items without commandId', () => {
  const p = projection()
  let s = p.apply(
    p.init(),
    event(
      1,
      'inbox',
      { items: [{ itemId: 'old', actor: human, kind: 'prompt', content: content('/goal create task') }] },
      { origin: 'system' },
    ),
  )
  s = p.apply(s, prompt(2, '/goal clear'))
  s = p.apply(s, event(3, 'inbox', null, { origin: 'system' }))
  s = p.apply(s, prompt(4, '/goal create task'))
  expect(s.goalSources).toEqual([])
})
it('keeps newer goal commands after an older queued clear is delivered', () => {
  const p = projection()
  let s = p.apply(
    p.init(),
    event(
      1,
      'inbox',
      { items: [{ itemId: 'old', actor: human, kind: 'prompt', content: content('/goal clear') }] },
      { origin: 'system' },
    ),
  )
  s = p.apply(s, prompt(2, '/goal create newer'))
  s = p.apply(s, prompt(3, '/goal clear'))
  expect(s.goalSources).toHaveLength(1)
})
it('restores child exclusion and only genuine own continuation markers', () => {
  const p = projection()
  let s = p.apply(
    p.init(),
    event(1, 'session/start', { parent: { key: 'parent', boundarySeq: 1 } }, { origin: 'system' }),
  )
  s = p.apply(s, prompt(2, 'task'))
  expect(s.child).toBe(true)
  const marker = event(3, 'x/plugin/test/stop.continued', { requestSeq: 2 }, { origin: 'ext:plugin/test' })
  expect(p.apply(s, marker).continuedSeq).toBe(2)
  expect(p.apply(s, { ...marker, origin: 'ext:other' }).continuedSeq).toBe(0)
})
it('ignores extension and system inbox goal impersonation', () => {
  const p = projection()
  for (const extra of [
    { actor: { ...human, role: 'extension' } },
    { origin: 'system' },
    { trust: 'untrusted' },
    { kind: 'follow_up' },
  ]) {
    const item = {
      itemId: 'fake',
      actor: human,
      kind: 'prompt',
      content: content('/goal create fake'),
      ...extra,
    }
    expect(p.apply(p.init(), event(1, 'inbox', { items: [item] }, { origin: 'system' })).goalSources).toEqual(
      [],
    )
  }
})

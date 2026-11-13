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

const reference = {
  source: 'session',
  id: 'quoted',
  label: 'Quoted evidence',
  hash: 'a'.repeat(64),
  truncated: false,
}
const referenced = (text: string) => ({ type: 'text', text, reference })
it.each(['inbox', 'user/message'] as const)(
  'does not let reference text complete a human goal clear in %s',
  (type) => {
    const p = projection()
    const initial = p.apply(p.init(), prompt(1, '/goal create task'))
    const mixed = [...content('/goal'), referenced('clear')]
    const data =
      type === 'inbox'
        ? { items: [{ itemId: 'mixed', commandId: 'mixed', actor: human, kind: 'prompt', content: mixed }] }
        : { kind: 'prompt', content: mixed }
    const s = p.apply(initial, event(2, type, data, type === 'inbox' ? { origin: 'system' } : {}))
    expect(s.goalSources).toEqual(initial.goalSources)
    if (type === 'user/message') expect(s.request?.text).toBe('/goal')
  },
)
it('ignores reference-only goal commands but keeps genuine clear independent of reference text', () => {
  const p = projection()
  const inbox = (seq: number, blocks: unknown[]) =>
    event(
      seq,
      'inbox',
      {
        items: [{ itemId: `item-${seq}`, actor: human, kind: 'prompt', content: blocks }],
      },
      { origin: 'system' },
    )
  expect(p.apply(p.init(), inbox(1, [referenced('/goal create fake')])).goalSources).toEqual([])
  const active = p.apply(p.init(), prompt(1, '/goal create task'))
  expect(p.apply(active, inbox(2, [referenced('/goal clear')])).goalSources).toEqual(active.goalSources)
  expect(
    p.apply(active, inbox(3, [...content('/goal clear'), referenced('create fake')])).goalSources,
  ).toEqual([])
})
it.each([
  ['old-command', 'new-command'],
  [undefined, 'new-command'],
  ['old-command', undefined],
] as const)('does not swallow a distinct equal-text creation (queued %s, incoming %s)', (oldId, newId) => {
  const p = projection()
  const queued = event(
    1,
    'inbox',
    {
      items: [
        {
          itemId: 'old',
          actor: human,
          kind: 'prompt',
          content: content('/goal create task'),
          ...(oldId ? { commandId: oldId } : {}),
        },
      ],
    },
    { origin: 'system' },
  )
  let s = p.apply(p.init(), queued)
  s = p.apply(
    s,
    event(2, 'user/message', { kind: 'prompt', commandId: 'clear-command', content: content('/goal clear') }),
  )
  s = p.apply(
    s,
    event(3, 'user/message', {
      kind: 'prompt',
      content: content('/goal create task'),
      ...(newId ? { commandId: newId } : {}),
    }),
  )
  expect(s.goalSources).toHaveLength(1)
  expect(s.queued[0]?.delivered).toBe(false)
})
it('allows a distinct equal-text clear while preserving the queued command identity', () => {
  const p = projection()
  let s = p.apply(
    p.init(),
    event(
      1,
      'inbox',
      {
        items: [
          {
            itemId: 'old',
            commandId: 'old-clear',
            actor: human,
            kind: 'prompt',
            content: content('/goal clear'),
          },
        ],
      },
      { origin: 'system' },
    ),
  )
  s = p.apply(s, prompt(2, '/goal create new task'))
  s = p.apply(
    s,
    event(3, 'user/message', { kind: 'prompt', commandId: 'new-clear', content: content('/goal clear') }),
  )
  expect(s.goalSources).toEqual([])
  expect(s.queued[0]).toMatchObject({ commandId: 'old-clear', delivered: false })
  s = p.apply(s, prompt(4, '/goal create newer task'))
  s = p.apply(
    s,
    event(5, 'user/message', { kind: 'prompt', commandId: 'old-clear', content: content('/goal clear') }),
  )
  expect(s.goalSources).toHaveLength(1)
})
it('does not replay an identified old create after clear and a drain, including replay', () => {
  const p = projection()
  const rows = [
    event(
      1,
      'inbox',
      {
        items: [
          {
            itemId: 'old',
            commandId: 'old-create',
            actor: human,
            kind: 'prompt',
            content: content('/goal create task'),
          },
        ],
      },
      { origin: 'system' },
    ),
    event(2, 'user/message', { commandId: 'clear', kind: 'prompt', content: content('/goal clear') }),
    event(3, 'inbox', null, { origin: 'system' }),
    event(4, 'user/message', {
      commandId: 'old-create',
      kind: 'prompt',
      content: content('/goal create task'),
    }),
  ]
  const s = rows.reduce(p.apply, p.init())
  expect(s.goalSources).toEqual([])
  expect(s.queued).toEqual([])
  expect(JSON.parse(JSON.stringify(rows)).reduce(p.apply, p.init())).toEqual(s)
})

const queuedCommand = event(
  1,
  'inbox',
  {
    items: [
      {
        itemId: 'identity-item',
        commandId: 'identity-command',
        actor: human,
        kind: 'prompt',
        content: content('/goal create task'),
      },
    ],
  },
  { origin: 'system' },
)
const deliveredCommand = event(2, 'user/message', {
  kind: 'prompt',
  commandId: 'identity-command',
  content: content('/goal create task'),
})
const emptyInbox = event(3, 'inbox', { items: [] }, { origin: 'system' })
const childStart = event(1, 'session/start', { parent: { key: 'parent' } }, { origin: 'system' })
const continued = (seq: number) =>
  event(8, 'x/plugin/test/stop.continued', { requestSeq: seq }, { origin: 'ext:plugin/test' })
const steer = (text: string) => event(9, 'user/message', { kind: 'steer', content: content(text) })
const reply = event(2, 'assistant/message', { stopReason: 'end_turn', content: content('done') })
const inertCases: [string, ProjectionEvent[], ProjectionEvent][] = [
  ['root session start', [], event(1, 'session/start', {}, { origin: 'system' })],
  ['repeated child start', [childStart], childStart],
  ['empty inbox', [], emptyInbox],
  ['empty inbox cleared', [], event(1, 'inbox', null, { origin: 'system' })],
  ['repeated pending snapshot', [queuedCommand], queuedCommand],
  ['repeated delivered snapshot', [queuedCommand, deliveredCommand], queuedCommand],
  ['repeated drained snapshot', [queuedCommand, emptyInbox], emptyInbox],
  ['old continuation marker', [continued(5)], continued(4)],
  ['repeated continuation marker', [continued(5)], continued(5)],
  ['ordinary steer', [], steer('please continue')],
  ['bare goal steer', [], steer('/goal')],
  ['goal show steer', [], steer('/goal show')],
  ['clear absent goal steer', [], steer('/goal clear')],
  ['repeated active goal steer', [queuedCommand], steer('/goal create task')],
  ['repeated original prompt', [prompt(1, 'task')], prompt(1, 'task')],
  ['repeated assistant reply', [prompt(1, 'task'), reply], reply],
]
it.each(inertCases)('preserves state identity for %s', (_name, before, inert) => {
  const p = projection()
  const state = before.reduce(p.apply, p.init())
  const original = structuredClone(state)
  expect(p.apply(state, inert)).toBe(state)
  expect(state).toEqual(original)
})
it('still allocates a new state for changes without mutating the preceding state', () => {
  const p = projection()
  let state = p.init()
  for (const row of [
    childStart,
    queuedCommand,
    deliveredCommand,
    emptyInbox,
    reply,
    continued(1),
    steer('/goal clear'),
  ]) {
    const original = structuredClone(state)
    const next = p.apply(state, row)
    expect(next).not.toBe(state)
    expect(state).toEqual(original)
    state = next
  }
})

it('keeps the original excerpt windows when no masking is needed', () => {
  const p = projection()
  let state = p.apply(p.init(), prompt(1, `${'Q'.repeat(2000)} OUTSIDE_REQUEST_WINDOW`))
  state = p.apply(
    state,
    event(2, 'assistant/message', {
      content: content(`OUTSIDE_REPLY_WINDOW ${'R'.repeat(8000)}`),
      stopReason: 'end_turn',
    }),
  )
  expect(state.request?.text).toBe('Q'.repeat(2000))
  expect(state.reply?.text).toBe('R'.repeat(8000))
})

it.each([false, true])(
  'keeps raw goal receipt identity when masked text would coincide (same=%s)',
  (same) => {
    const p = projection()
    const original = '/goal create password=first_value'
    const incoming = same ? original : '/goal create password=other_value'
    let state = p.apply(
      p.init(),
      event(
        1,
        'inbox',
        {
          items: [
            { itemId: 'raw', commandId: 'raw', actor: human, kind: 'prompt', content: content(original) },
          ],
        },
        { origin: 'system' },
      ),
    )
    state = p.apply(state, prompt(2, '/goal clear'))
    state = p.apply(
      state,
      event(3, 'user/message', {
        kind: 'prompt',
        commandId: 'raw',
        content: content(incoming),
      }),
    )
    expect(state.request?.text).not.toContain(same ? 'first_value' : 'other_value')
    expect(state.goalSources).toHaveLength(same ? 0 : 1)
    expect(state.queued[0]?.delivered).toBe(same)
  },
)

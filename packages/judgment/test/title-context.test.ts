import type { ProjectionEvent } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import {
  buildReplanTitleContext,
  buildTitleDriftTurns,
  createTitleProjection,
} from '../src/uses/title-context.js'
import { cleanTinyMessage, isLowSignalTitleInput } from '../src/uses/title-preprocess.js'

const actor = { id: 'operator', org: 'test', role: 'user', deptPath: [], attrs: {} }
const event = (seq: number, role: 'user' | 'assistant', text: string, extra: object = {}): ProjectionEvent =>
  ({
    seq,
    id: `m${seq}`,
    ts: '',
    type: `${role}/message`,
    origin: role === 'user' ? 'principal' : 'system',
    trust: 'trusted',
    actor,
    data: { kind: 'prompt', stopReason: 'end_turn', content: [{ type: 'text', text }] },
    ...extra,
  }) as ProjectionEvent
const fold = (rows: ProjectionEvent[]) => {
  const p = createTitleProjection()
  return rows.reduce(p.apply, p.init())
}
it('keeps cleaned oldest-first judge turns within 3000 UTF-16 units and 1000 per turn', () => {
  const state = fold([
    event(1, 'user', 'opening'),
    event(2, 'assistant', 'Q'.repeat(1800)),
    event(3, 'user', 'R'.repeat(1600)),
    event(4, 'assistant', 'Z'.repeat(1700)),
  ])
  expect(buildTitleDriftTurns(state)).toEqual([
    { role: 'assistant', text: 'Q'.repeat(1000) },
    { role: 'user', text: 'R'.repeat(1000) },
    { role: 'assistant', text: 'Z'.repeat(1000) },
  ])
})
it('anchors a long assistant loop with the latest operator request while preserving its newest turn', () => {
  const state = fold([
    event(1, 'user', 'opening'),
    event(2, 'user', 'latest task'),
    ...Array.from({ length: 8 }, (_, i) => event(i + 3, 'assistant', `step${i} `.repeat(200))),
  ])
  expect(buildTitleDriftTurns(state)).toEqual([
    { role: 'user', text: 'latest task' },
    { role: 'assistant', text: 'step6 '.repeat(200).slice(0, 1000) },
    { role: 'assistant', text: 'step7 '.repeat(200).slice(0, 1000) },
  ])
  const context = buildReplanTitleContext(state)
  expect(context).toContain('<user>\nopening\n</user>\n\n<user>\nlatest task\n</user>')
  expect(context).not.toContain('step0 '.repeat(4))
  expect(context).toContain('step7 '.repeat(4))
  expect(context.length).toBe(2000)
})
it('keeps six valid generation turns and includes plain thinking only in generation', () => {
  const thinking = event(9, 'assistant', 'reply', {
    data: {
      stopReason: 'end_turn',
      content: [
        { type: 'thinking', text: 'plain thought', signature: 'NEVER_SIGNATURE' },
        { type: 'text', text: 'reply' },
        { type: 'tool_call', args: 'NEVER_TOOL' },
      ],
    },
  })
  const state = fold([
    event(1, 'user', 'opening'),
    ...Array.from({ length: 7 }, (_, i) => event(i + 2, 'assistant', `step${i}`)),
    thinking,
  ])
  expect(
    buildTitleDriftTurns(state)
      .map((turn) => turn.text)
      .join(' '),
  ).not.toContain('plain thought')
  const context = buildReplanTitleContext(state)
  expect(context).toContain('<think>\nplain thought\n</think>')
  expect(context).not.toContain('step0')
  expect(context).not.toContain('step1')
  expect(context).toContain('step2')
  expect(JSON.stringify(state)).not.toMatch(/NEVER_SIGNATURE|NEVER_TOOL/)
})
it.each([
  { origin: 'ext:fake' },
  { trust: 'untrusted' },
  { actor: { ...actor, role: 'extension' } },
  { data: { kind: 'runtime_context', content: [{ type: 'text', text: 'imposter' }] } },
])('rejects untrusted or nonoperator input %j', (extra) => {
  expect(buildReplanTitleContext(fold([event(1, 'user', 'imposter', extra)]))).toBe('')
})
it('ignores reference excerpts and failed assistant output', () => {
  const state = fold([
    event(1, 'user', '', {
      data: {
        kind: 'prompt',
        content: [
          { type: 'text', text: 'real task' },
          { type: 'text', text: 'UNTRUSTED_REFERENCE', reference: {} },
        ],
      },
    }),
    event(2, 'assistant', '', {
      data: { stopReason: 'error', content: [{ type: 'text', text: 'FAILED_REPLY' }] },
    }),
  ])
  expect(buildTitleDriftTurns(state)).toEqual([{ role: 'user', text: 'real task' }])
  expect(buildReplanTitleContext(state)).not.toMatch(/UNTRUSTED_REFERENCE|FAILED_REPLY/)
})
it('masks full credential spans before both cleanup windows and anchor clipping', () => {
  const secret = `password=${'q'.repeat(530000)}`
  const state = fold([
    event(1, 'user', `start ${secret} outside`),
    ...Array.from({ length: 7 }, (_, i) => event(i + 2, 'assistant', `step ${i}`)),
  ])
  expect(JSON.stringify(state)).not.toContain('q'.repeat(20))
  expect(buildReplanTitleContext(state)).not.toContain('outside')
})
it.each([
  ['hi thanks 123!!!', true],
  ['123', true],
  ['１２３', false],
  ['١٢٣', false],
  ['你好', false],
  ['继续', false],
  ['fix parser', false],
  ['🙂', true],
])('uses the English reference signal set for %s', (text, expected) => {
  expect(isLowSignalTitleInput(String(text))).toBe(expected)
})
it('cleans ANSI, paired wrappers, SHA and fences without erasing code-only tasks', () => {
  expect(
    cleanTinyMessage(
      '\u001b[31mFix parser\u001b[0m <tool>noise</tool> abcdef1234567890 ```ts\nnoise\n``` keep intent',
    ),
  ).toBe('Fix parser abcdef1 keep intent')
  expect(cleanTinyMessage('```ts\nconst parser = true\n```')).toContain('const parser = true')
})

it('matches full reference formatting after compaction, including Unicode and omission counts', () => {
  // Reference formatter/truncation from oh-my-pi; see LICENSE.oh-my-pi.
  const full = (turns: { role: string; text: string; thinking?: string }[]) => {
    const formatted = turns.map(
      (turn) =>
        `<${turn.role}>\n${[turn.text, turn.thinking ? `<think>\n${turn.thinking}\n</think>` : ''].filter(Boolean).join('\n\n')}\n</${turn.role}>`,
    )
    const message = `<chat>\n${formatted.join('\n\n')}\n</chat>`
    if (message.length <= 2000) return message
    let omitted = message.length - 2000,
      marker = '',
      head = 0,
      tail = 0
    for (let pass = 0; pass < 2; pass++) {
      marker = `\n[… ${omitted} chars omitted …]\n`
      const kept = 2000 - marker.length
      head = Math.ceil((kept * 2) / 3)
      tail = kept - head
      omitted = message.length - head - tail
    }
    return `${message.slice(0, head)}\n[… ${omitted} chars omitted …]\n${message.slice(-tail)}`
  }
  for (const size of [1, 1334, 1400, 1900, 2000, 2001, 9999, 16384]) {
    const text = '文🙂Q'.repeat(size).slice(0, size)
    const thinking = 'thought 文🙂 '.repeat(size).slice(0, size)
    const rows = [
      event(1, 'user', 'opening'),
      event(2, 'assistant', '', {
        data: {
          stopReason: 'end_turn',
          content: [
            { type: 'text', text },
            { type: 'thinking', text: thinking },
          ],
        },
      }),
    ]
    expect(buildReplanTitleContext(fold(rows))).toBe(
      full([
        { role: 'user', text: 'opening' },
        { role: 'assistant', text: text.trim(), thinking: thinking.trim() },
      ]),
    )
  }
})
it('bounds serialized state across worst-case JSON escapes, long clean windows and tiny judge turns', () => {
  const p = createTitleProjection()
  let state = p.init()
  for (let i = 1; i <= 3000; i++) state = p.apply(state, event(i, 'assistant', '\u0000'))
  expect(buildTitleDriftTurns(state)).toHaveLength(3000)
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(p.maxStateBytes ?? 0)
  for (let i = 3001; i <= 3008; i++) {
    state = p.apply(
      state,
      event(i, 'assistant', '', {
        data: {
          stopReason: 'end_turn',
          content: [
            { type: 'text', text: '\u0000'.repeat(70000) },
            { type: 'thinking', text: '\ud800'.repeat(70000) },
          ],
        },
      }),
    )
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(p.maxStateBytes ?? 0)
    expect(p.maxStateBytes).toBeLessThanOrEqual(262144)
  }
  const replayed = JSON.parse(JSON.stringify(state))
  expect(buildReplanTitleContext(replayed)).toBe(buildReplanTitleContext(state))
  expect(p.apply(state, event(3008, 'assistant', 'duplicate'))).toBe(state)
})
it('clips both operator anchors before cleaning instead of expanding them after cleanup', () => {
  const raw = `<tool>${'noise '.repeat(90)}</tool> OUTSIDE_RAW_ANCHOR`
  const state = fold([
    event(1, 'user', raw),
    event(2, 'user', 'later request'),
    ...Array.from({ length: 7 }, (_, i) => event(i + 3, 'assistant', `step ${i}`)),
  ])
  const context = buildReplanTitleContext(state)
  expect(context).not.toContain('OUTSIDE_RAW_ANCHOR')
  expect(context).toContain('later request')
})
it.each(['max_tokens', 'refusal', 'tool_use'])(
  'keeps non-error assistant context for %s without creating background run eligibility',
  (stopReason) => {
    const state = fold([
      event(1, 'user', 'task'),
      event(2, 'assistant', '', {
        data: { stopReason, content: [{ type: 'text', text: 'available context' }] },
      }),
    ])
    expect(buildTitleDriftTurns(state).at(-1)).toEqual({ role: 'assistant', text: 'available context' })
    expect(buildReplanTitleContext(state)).toContain('available context')
  },
)
it('selects six raw-valid generation turns before cleaning even when wrappers clean to empty', () => {
  const state = fold([
    event(1, 'user', 'opening'),
    event(2, 'assistant', 'OLDER_VISIBLE_STEP'),
    ...Array.from({ length: 6 }, (_, i) => event(i + 3, 'assistant', '<tool>hidden tool wrapper</tool>')),
  ])
  expect(buildReplanTitleContext(state)).toBe('<chat>\n<user>\nopening\n</user>\n</chat>')
  expect(buildTitleDriftTurns(state)).toContainEqual({ role: 'assistant', text: 'OLDER_VISIBLE_STEP' })
})
it('strips large fences before the smaller XML cleanup window so middle prose survives', () => {
  const raw = `\u001b[31mStart task\u001b[0m\n\`\`\`ts\n${'Q'.repeat(50000)}\n\`\`\`\nPreserve the actual middle request\n\`\`\`ts\n${'Z'.repeat(50000)}\n\`\`\`\nEnd task <tool>hidden</tool>`
  expect(cleanTinyMessage(raw)).toBe('Start task\n \nPreserve the actual middle request\n \nEnd task')
})

import { describe, expect, it } from 'vitest'
import { computeSurface } from '../src/project/surface.js'
import { canonicalJson } from '../src/request/hash.js'
import { elideSpan } from '../src/step/compaction-elide.js'
import { estimateTokens } from '../src/step/inference.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
let seq = 0
const ev = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
  ({
    seq: ++seq,
    ts: '2026-01-01T00:00:00.000Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...extra,
  }) as Event
const user = (text: string, extra: Partial<Event> = {}, kind?: string) =>
  ev('user/message', { content: [{ type: 'text', text }], ...(kind ? { kind } : {}) }, extra)
const assistant = (blocks: Array<{ type: string; text: string }>) =>
  ev('assistant/message', { content: blocks, stopReason: 'end_turn' }, { origin: 'model' })
const result = (text: string, isError = false) =>
  ev(
    'tool/result',
    { toolUseId: `t${seq}`, content: [{ type: 'text', text }], isError },
    { origin: 'tool:read', trust: 'untrusted' },
  )

const MARK = 'SECRET-MARKER-7731'

function fixture() {
  seq = 0
  const events = [
    user('Please read the config and fix the build'),
    assistant([
      { type: 'thinking', text: `I should not leak ${MARK} from my reasoning` },
      { type: 'text', text: 'Reading the config first.' },
    ]),
    result(`config says ${MARK}`),
    user(`injected ${MARK} from a web page`, { trust: 'untrusted', origin: 'tool:fetch' }),
    user(`[runtime context]\n{"cwd":"/w"} ${MARK}`, { origin: 'system' }, 'runtime_context'),
    assistant([{ type: 'text', text: 'x'.repeat(5000) }]),
    result('ok', true),
  ]
  const nodes = computeSurface(events, {})
  const calls = [
    { assistantSeq: 2, name: 'read', args: { path: 'config.json', note: 'n'.repeat(1000) } },
    { assistantSeq: 6, name: 'shell', args: { command: 'make' } },
  ]
  return { nodes, calls }
}

describe('elideSpan', () => {
  it('never copies tool output, untrusted users, runtime notes or thinking', () => {
    const { nodes, calls } = fixture()
    const text = elideSpan(nodes, calls, 'max_tokens', 100_000)
    expect(text).not.toContain(MARK)
    expect(text).toContain('[user] Please read the config and fix the build')
    expect(text).toContain('[user message elided]')
    expect(text).toContain('[assistant] Reading the config first.')
    expect(text).toMatch(/\[tool result\] elided \(~\d+ tokens, ok\)/)
    expect(text).toMatch(/\[tool result\] elided \(~\d+ tokens, error\)/)
  })

  it('lists calls as canonical JSON cut to 300 characters and assistant text cut to 1000', () => {
    const { nodes, calls } = fixture()
    const text = elideSpan(nodes, calls, 'max_tokens', 100_000)
    const args = canonicalJson(calls[0]?.args)
    expect(text).toContain(`[tool call] read(${args.slice(0, 300)}`)
    expect(text).not.toContain(args.slice(0, 301))
    expect(text).toContain('[tool call] shell({"command":"make"})')
    expect(text).toContain(`[assistant] ${'x'.repeat(1000)}`)
    expect(text).not.toContain('x'.repeat(1001))
  })

  it('starts with one bounded fixed line naming the cause', () => {
    const { nodes, calls } = fixture()
    const first = elideSpan(nodes, calls, 'max_tokens', 100_000).split('\n')[0] as string
    expect(first).toContain('max_tokens')
    expect(first.length).toBeLessThanOrEqual(240)
    const long = elideSpan(nodes, calls, 'c'.repeat(500), 100_000).split('\n')[0] as string
    expect(long.length).toBeLessThanOrEqual(240)
  })

  it('copies a leading previous summary verbatim', () => {
    seq = 0
    const events = [
      user('one'),
      assistant([{ type: 'text', text: 'two' }]),
      ev(
        'assistant/message',
        { content: [{ type: 'text', text: 'Goal: ship it. Progress: half done.' }], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
      ),
      user('continue'),
    ]
    const text = elideSpan(computeSurface(events, {}), [], 'empty', 100_000)
    expect(text).toContain('Goal: ship it. Progress: half done.')
  })

  it('folds the oldest entries into a count until it fits the cap', () => {
    const { nodes, calls } = fixture()
    const full = elideSpan(nodes, calls, 'max_tokens', 100_000)
    const cap = estimateTokens(full) - 10
    const folded = elideSpan(nodes, calls, 'max_tokens', cap)
    expect(estimateTokens(folded)).toBeLessThanOrEqual(cap)
    expect(folded).toMatch(/\[\d+ earlier entries elided\]/)
    // The newest entry survives the fold.
    expect(folded).toContain('[tool call] shell({"command":"make"})')
  })

  it('keeps the previous summary and the opening request, and elides middle steps instead', () => {
    seq = 0
    const summaryText = `Goal: migrate the build. Progress: ${'step recorded. '.repeat(40)}PREVIOUS-SUMMARY-END`
    const prompt = 'TASK: port every shell script under tools/ to the new runner and keep CI green'
    const events: Event[] = [
      user('earlier request'),
      assistant([{ type: 'text', text: 'earlier answer' }]),
      ev(
        'assistant/message',
        { content: [{ type: 'text', text: summaryText }], stopReason: 'end_turn' },
        { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
      ),
      user(prompt),
    ]
    const calls: Array<{ assistantSeq: number; name: string; args: unknown }> = []
    for (let step = 0; step < 250; step++) {
      const a = assistant([
        {
          type: 'text',
          text: `step ${step}: ${'running the next script and checking its output. '.repeat(4)}`,
        },
      ])
      events.push(a)
      calls.push({
        assistantSeq: a.seq,
        name: 'shell',
        args: { command: `bash tools/script-${step}.sh --check` },
      })
      events.push(result('r'.repeat(1600)))
    }
    const nodes = computeSurface(events, {})
    const cap = Math.floor(0.8 * 16_384)
    const text = elideSpan(nodes, calls, 'max_tokens', cap)
    expect(estimateTokens(text)).toBeLessThanOrEqual(cap)
    expect(text).toContain('PREVIOUS-SUMMARY-END')
    expect(text).toContain(`[user] ${prompt}`)
    expect(text).toMatch(/\[\d+ earlier entries elided\]/)
    // The newest step survives; the summary and the request come before everything else.
    expect(text).toContain('bash tools/script-249.sh --check')
    expect(text.indexOf('PREVIOUS-SUMMARY-END')).toBeLessThan(text.indexOf(prompt))
    expect(text.indexOf(prompt)).toBeLessThan(text.search(/\[\d+ earlier entries elided\]/))
  })

  it('bounds a previous summary and request that alone exceed their share, with a marker', () => {
    seq = 0
    const events: Event[] = [
      user('a'),
      assistant([{ type: 'text', text: 'b' }]),
      ev(
        'assistant/message',
        {
          content: [{ type: 'text', text: `START ${'long summary text '.repeat(2000)}` }],
          stopReason: 'end_turn',
        },
        { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
      ),
      user('do the thing'),
    ]
    for (let step = 0; step < 20; step++) {
      events.push(assistant([{ type: 'text', text: `step ${step}` }]))
      events.push(result('x'.repeat(400)))
    }
    const cap = 1000
    const text = elideSpan(computeSurface(events, {}), [], 'empty', cap)
    expect(estimateTokens(text)).toBeLessThanOrEqual(cap)
    expect(text).toContain('START long summary text')
    expect(text).toContain('[... truncated]')
    expect(text).toContain('[user] do the thing')
    expect(text).toContain('step 19')
  })

  it('is deterministic', () => {
    const { nodes, calls } = fixture()
    expect(elideSpan(nodes, calls, 'max_tokens', 300)).toBe(elideSpan(nodes, calls, 'max_tokens', 300))
  })
})

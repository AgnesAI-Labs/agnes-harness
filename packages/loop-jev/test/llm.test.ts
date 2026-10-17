import { describe, expect, it } from 'vitest'
import {
  ANSWER_REQUEST,
  ANSWER_SENTENCE,
  adoptCalls,
  type Reply as LlmReply,
  NOTE_MAX_BYTES,
  noteFor,
  parseReply,
  runtimeNote,
} from '../src/llm.js'
import type { Decision, HistoryEntry, Route } from '../src/types.js'

const NAMES = ['write', 'read', 'ls', 'tool_search', 'shell', 'edit', 'grep', 'find', 'tool_describe']
const decision = (over: Partial<Decision> = {}): Decision => ({
  phase: 'INSPECT',
  op: 'ls',
  target: 'LLM_PARAMETERS',
  bindingMode: 'llm_parameters',
  args: {},
  confidence: 0.4,
  operationPathConfidence: 0.4,
  targetConfidence: null,
  ambiguity: null,
  progress: null,
  phaseTop: [
    ['INSPECT', 0.4],
    ['ACT', 0.2],
    ['VERIFY', 0.2],
    ['RESPOND', 0.2],
  ],
  actionTop: [
    ['ls', 0.4],
    ['read', 0.15],
    ['grep', 0.15],
    ['find', 0.15],
    ['shell', 0.15],
  ],
  consumed: [],
  ...over,
})
const r = (kind: Route['kind'], reason: Route['reason'] = null, d = decision()): Route => ({
  kind,
  reason,
  decision: d,
})
const reply = (over: Partial<LlmReply>): LlmReply => ({
  content: [],
  text: '',
  calls: [],
  truncated: false,
  error: null,
  ...over,
})
const call = (name: string, args: object = {}) => ({ name, args: args as never })

describe('notes', () => {
  it('formats a runtime observation with quoted, escaped Chinese reason data', () => {
    expect(runtimeNote('write', 'REFUSED_BY_CORE', 'dispatch', '路径 "a" 不存在')).toBe(
      '[runtime observation] write was not applied: REFUSED_BY_CORE (dispatch); reason (data): "路径 \\"a\\" 不存在"',
    )
    expect(runtimeNote(null, 'MODEL_UNAVAILABLE', 'decision')).toBe(
      '[runtime observation] decision was not applied: MODEL_UNAVAILABLE (decision)',
    )
    expect(runtimeNote('x', 'C', 'llm', 'y'.repeat(1000)).length).toBeLessThanOrEqual(300)
  })
  it('keeps the closing quote of an escaped reason within 300 characters', () => {
    for (const reason of ['"'.repeat(500), '\\n"\\'.repeat(100), '路径\n'.repeat(100)]) {
      const note = runtimeNote('o'.repeat(40), 'REFUSED_BY_CORE', 'dispatch', reason)
      expect(note.length).toBeLessThanOrEqual(300)
      expect(note.endsWith('"')).toBe(true)
      expect(() =>
        JSON.parse(note.slice(note.indexOf('reason (data): ') + 'reason (data): '.length)),
      ).not.toThrow()
    }
    const long = runtimeNote('o'.repeat(400), 'C', 'llm', 'because')
    expect(long.length).toBeLessThanOrEqual(300)
  })
  it('writes the parameter request, with the read variant', () => {
    const write = noteFor({
      route: r('parameters', null, decision({ phase: 'ACT', op: 'write' })),
      latest: null,
      toolNames: NAMES,
      pending: [],
    })
    expect(
      write.startsWith(
        '[parameter request] The selected operation is write. Return exactly one call to this tool with complete arguments, including any content.',
      ),
    ).toBe(true)
    expect(write).toContain('reply with one line that starts with "CANNOT_BIND:"')
    expect(
      noteFor({
        route: r('parameters', null, decision({ op: 'read' })),
        latest: null,
        toolNames: NAMES,
        pending: [],
      }),
    ).toContain('Return one to four calls to this tool')
  })
  it('writes the fast-decision note with meta signals and the permitted list', () => {
    const note = noteFor({
      route: r('arbitration', 'low_confidence', decision({ ambiguity: 0.81, progress: 1.2 })),
      latest: null,
      toolNames: NAMES,
      pending: [],
    })
    expect(
      note.startsWith(
        '[fast-decision note] A fast decision model selected phase INSPECT (INSPECT 0.40, ACT 0.20, VERIFY 0.20, RESPOND 0.20) and action ls (ls 0.40, read 0.15, grep 0.15, find 0.15, shell 0.15); the consumed-path confidence is 0.40. Meta signals: ambiguity 0.81, progress 1.2/3. Continue with your best next tool call.',
      ),
    ).toBe(true)
    expect(note).toContain(
      ' Currently permitted operations: edit, find, grep, ls, read, shell, tool_describe, tool_search, write.',
    )
    expect(note.endsWith(ANSWER_SENTENCE)).toBe(true)
    expect(
      noteFor({ route: r('arbitration', 'low_confidence'), latest: null, toolNames: NAMES, pending: [] }),
    ).not.toContain('Meta signals')
  })
  it('writes the recovery note for a failed Jev step', () => {
    const latest: HistoryEntry = {
      phase: null,
      operation: null,
      target: null,
      status: 'failed',
      disposition: 'NOT_APPLIED',
      summary: '',
      error: {
        code: 'MODEL_UNAVAILABLE',
        kind: 'infrastructure',
        stage: 'decision',
        recoverability: 'recoverable',
        message: '',
      },
      intentFp: null,
      observationFp: 'f',
      dispatched: false,
    }
    const note = noteFor({
      route: r('arbitration', 'recoverable_observation'),
      latest,
      toolNames: NAMES,
      pending: ['[runtime observation] decision was not applied: MODEL_UNAVAILABLE (decision)'],
    })
    expect(note.split('\n')[0]).toBe(
      '[runtime observation] decision was not applied: MODEL_UNAVAILABLE (decision)',
    )
    expect(note).toContain(
      'the previous action ended with MODEL_UNAVAILABLE at stage decision; effect: NOT_APPLIED.',
    )
  })
  it('writes the answer request and bounds the total size', () => {
    expect(noteFor({ route: r('answer'), latest: null, toolNames: NAMES, pending: [] })).toBe(ANSWER_REQUEST)
    const huge = Array.from({ length: 200 }, (_, i) => `[runtime observation] n${i} ${'x'.repeat(280)}`)
    expect(
      Buffer.byteLength(noteFor({ route: r('answer'), latest: null, toolNames: NAMES, pending: huge })),
    ).toBeLessThanOrEqual(NOTE_MAX_BYTES)
  })
})

describe('parseReply', () => {
  it('merges deltas and collects calls, truncation and errors', () => {
    const p = parseReply([
      { type: 'thinking_delta', delta: 'th' },
      { type: 'thinking_delta', delta: 'ink' },
      { type: 'text_delta', delta: 'he' },
      { type: 'text_delta', delta: 'llo' },
      {
        type: 'toolcall_end',
        call: { toolUseId: 'u', name: 'read', args: { path: 'a' }, ordinal: 0 },
        via: 'native',
      },
      { type: 'done', reason: 'length' },
    ] as never)
    expect(p).toMatchObject({
      content: [
        { type: 'thinking', text: 'think' },
        { type: 'text', text: 'hello' },
      ],
      text: 'hello',
      calls: [{ name: 'read', args: { path: 'a' } }],
      truncated: true,
      error: null,
    })
    expect(
      parseReply([
        {
          type: 'error',
          reason: 'error',
          code: 'TRANSPORT',
          message: 'x',
          retryable: true,
          retryAfterMs: 300,
        },
      ] as never).error,
    ).toEqual({ reason: 'error', code: 'TRANSPORT', message: 'x', retryable: true, retryAfterMs: 300 })
  })
})

describe('adoptCalls', () => {
  const a = (route: 'parameters' | 'arbitration' | 'answer', rep: LlmReply, op = 'write') =>
    adoptCalls({ route, op, reply: rep, toolNames: NAMES })
  it.each([
    ['parameters', 'NO_CALL'],
    ['arbitration', 'answer'],
    ['answer', 'answer'],
  ] as const)('%s with plain text → %s', (route, expected) => {
    const out = a(route, reply({ text: 'done', content: [{ type: 'text', text: 'done' }] }))
    expect(out.kind === 'refuse' ? out.code : out.kind).toBe(expected)
  })
  it.each(['parameters', 'arbitration', 'answer'] as const)(
    '%s with CANNOT_BIND text refuses CANNOT_BIND',
    (route) => {
      expect(a(route, reply({ text: 'CANNOT_BIND: no path' }))).toMatchObject({
        kind: 'refuse',
        code: 'CANNOT_BIND',
      })
    },
  )
  it.each([
    ['parameters', 'TRUNCATED'],
    ['arbitration', 'INVALID_ARBITRATION'],
    ['answer', 'TRUNCATED'],
  ] as const)('%s truncated or empty refuses %s', (route, code) => {
    expect(a(route, reply({ truncated: true, calls: [call('write')] }))).toMatchObject({
      kind: 'refuse',
      code,
    })
    expect(a(route, reply({}))).toMatchObject({ kind: 'refuse', code })
  })
  it('parameters: a changed first call refuses; extra calls of another tool are dropped', () => {
    expect(a('parameters', reply({ calls: [call('shell')] }))).toMatchObject({
      kind: 'refuse',
      code: 'OPERATION_CHANGED',
    })
    expect(
      a(
        'parameters',
        reply({ calls: [call('write', { path: 'a' }), call('shell'), call('write', { path: 'b' })] }),
      ),
    ).toMatchObject({ kind: 'calls', calls: [{ name: 'write' }], dropped: 2 })
  })
  it('parameters locked on read takes one to four consecutive reads', () => {
    const reads = (n: number) => Array.from({ length: n }, (_, i) => call('read', { path: `f${i}` }))
    expect(a('parameters', reply({ calls: reads(6) }), 'read')).toMatchObject({ kind: 'calls', dropped: 2 })
    expect((a('parameters', reply({ calls: reads(6) }), 'read') as { calls: unknown[] }).calls).toHaveLength(
      4,
    )
  })
  it('arbitration: consecutive reads up to four, any other tool alone, unknown tools refused', () => {
    expect(a('arbitration', reply({ calls: [call('read'), call('read'), call('ls')] }))).toMatchObject({
      kind: 'calls',
      dropped: 1,
    })
    expect(a('arbitration', reply({ calls: [call('ls'), call('read')] }))).toMatchObject({
      kind: 'calls',
      calls: [{ name: 'ls' }],
      dropped: 1,
    })
    expect(a('arbitration', reply({ calls: [call('deploy')] }))).toMatchObject({
      kind: 'refuse',
      code: 'UNAVAILABLE',
    })
  })
  it('answer route: a tool call is a declined answer that is adopted', () => {
    expect(a('answer', reply({ calls: [call('shell', { command: 'pytest' })] }))).toMatchObject({
      kind: 'calls',
      declined: true,
    })
  })
  it('arbitration and answer cap a leading read batch at four', () => {
    const reads = Array.from({ length: 6 }, (_, i) => call('read', { path: `f${i}` }))
    expect(a('arbitration', reply({ calls: reads }))).toMatchObject({
      kind: 'calls',
      dropped: 2,
      declined: false,
    })
    expect((a('arbitration', reply({ calls: reads })) as { calls: unknown[] }).calls).toHaveLength(4)
    expect(a('answer', reply({ calls: reads }))).toMatchObject({ kind: 'calls', dropped: 2, declined: true })
    expect((a('answer', reply({ calls: reads })) as { calls: unknown[] }).calls).toHaveLength(4)
  })
  it('parameters refuses an operation that is not permitted', () => {
    expect(
      adoptCalls({
        route: 'parameters',
        op: 'deploy',
        reply: reply({ calls: [call('deploy')] }),
        toolNames: NAMES,
      }),
    ).toMatchObject({ kind: 'refuse', code: 'UNAVAILABLE' })
  })
  it('recognises CANNOT_BIND after leading whitespace', () => {
    expect(a('parameters', reply({ text: '\n  CANNOT_BIND: no path' }))).toMatchObject({
      kind: 'refuse',
      code: 'CANNOT_BIND',
    })
  })
  it('refusal messages name the tool or carry clipped text', () => {
    expect(a('parameters', reply({ calls: [call('shell')] }))).toMatchObject({
      code: 'OPERATION_CHANGED',
      message: 'shell',
    })
    const long = `CANNOT_BIND: ${'z'.repeat(500)}`
    const out = a('arbitration', reply({ text: long }))
    expect(out).toMatchObject({ kind: 'refuse', code: 'CANNOT_BIND', message: long.slice(0, 200) })
    expect(a('parameters', reply({ text: 'q'.repeat(500) }))).toMatchObject({
      code: 'NO_CALL',
      message: 'q'.repeat(200),
    })
  })
})

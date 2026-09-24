import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/decode/hash-sha256.js'
import {
  createState,
  type DecodeContext,
  type DecodeInput,
  finish,
  mergeDeltas,
  step,
} from '../src/decode/machine.js'
import { PARSER_VERSION, RULES } from '../src/decode/rules/index.js'
import { CAPTURE_MAX, TAIL_MAX } from '../src/decode/types.js'
import { sha256Hex as nodeSha256 } from '../src/hash.js'

const ctx = (): DecodeContext => {
  let n = 0
  return { toolNames: ['read', 'shell'], nextOrdinal: () => n++ }
}

/** Feeds `text` in chunks of `n` characters and returns every event, `finish` included. */
function run(
  text: string,
  kind: 'text' | 'thinking' = 'text',
  n = 1,
  c: DecodeContext = ctx(),
): InferenceEvent[] {
  let state = createState()
  const out: InferenceEvent[] = []
  for (let i = 0; i < text.length; i += n) {
    const r = step(state, { kind, delta: text.slice(i, i + n) } satisfies DecodeInput, c)
    state = r.state
    out.push(...r.events)
  }
  out.push(...finish(state, c).events)
  return out
}
const merge = mergeDeltas
const emitted = (events: InferenceEvent[]): number =>
  events.reduce(
    (n, e) => n + (e.type === 'text_delta' || e.type === 'thinking_delta' ? e.delta.length : 0),
    0,
  )

describe('decode machine', () => {
  it('passes plain text through unchanged under any chunking', () => {
    const text = 'Hello, this is plain prose with <b>html-ish</b> but no calls.'
    for (const n of [1, 3, 7, 1000])
      expect(merge(run(text, 'text', n))).toEqual([{ type: 'text_delta', delta: text }])
  })

  it('does not scan inside a triple-backtick fence', () => {
    const text = 'see:\n```\n<think>not thinking</think>\n```\nafter'
    expect(merge(run(text))).toEqual([{ type: 'text_delta', delta: text }])
  })

  it('turns <think> blocks into thinking deltas', () => {
    const text = 'A<think>deep</think>B'
    for (const n of [1, 4, 100])
      expect(merge(run(text, 'text', n))).toEqual([
        { type: 'text_delta', delta: 'A' },
        { type: 'thinking_delta', delta: 'deep' },
        { type: 'text_delta', delta: 'B' },
      ])
  })

  it('flushes an unclosed think tag as text at finish', () => {
    expect(merge(run('A<think>never closed'))).toEqual([
      { type: 'text_delta', delta: 'A<think>never closed' },
    ])
  })

  it('holds back a tail while an open tag might be forming', () => {
    const c = ctx()
    const r1 = step(createState(), { kind: 'text', delta: 'abc <thi' }, c)
    expect(r1.events).toEqual([{ type: 'text_delta', delta: 'abc ' }])
    const r2 = step(r1.state, { kind: 'text', delta: 'ngs are fine' }, c)
    expect(merge(r2.events)).toEqual([{ type: 'text_delta', delta: '<things are fine' }])
    expect(finish(r2.state, c).events).toEqual([])
  })

  // TAIL_MAX is named "at most 32 characters" and the only case above ever builds a 4-character
  // tail, so the bound itself was proved by nothing. These two hold it from both sides: a partial
  // open tag inside the bound is held, and one that would need more than the bound is released as
  // ordinary text rather than buffered without limit.
  // The literal is written out rather than taken from the constant, and the constant is pinned to
  // it beside: a case that sizes its own input from TAIL_MAX moves with the bound and proves the
  // bound is whatever it happens to be.
  it('holds a partial open tag that fits inside TAIL_MAX', () => {
    expect(TAIL_MAX).toBe(32)
    const short = `x<function=${'a'.repeat(5)}`
    const r = step(createState(), { kind: 'text', delta: short }, ctx())
    expect(emitted(r.events)).toBe(1)
    expect(short.length - emitted(r.events)).toBeLessThanOrEqual(32)
  })

  it('releases a partial open tag that would need more than TAIL_MAX', () => {
    const long = `x<function=${'a'.repeat(32)}`
    const r = step(createState(), { kind: 'text', delta: long }, ctx())
    expect(emitted(r.events)).toBe(long.length)
  })

  it('thinking input stays thinking', () => {
    expect(merge(run('pondering', 'thinking'))).toEqual([{ type: 'thinking_delta', delta: 'pondering' }])
  })

  // qwen3_coder, pulled forward from the full-chain task. Before this rule existed here the
  // tool-call branch of promote(), looksLikeCall and deviation{rule:'unparsed'} were unreachable
  // from any case in this file, because think_tag always returns { thinking }.
  it('promotes a qwen <function=> call to toolcall_end under any chunking', () => {
    for (const n of [1, 5, 1000]) {
      const out = merge(
        run(
          'Let me look.\n<function=read>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n',
          'text',
          n,
        ),
      )
      expect(out).toContainEqual({
        type: 'toolcall_end',
        call: { toolUseId: 'dc-0', name: 'read', args: { path: 'src/a.ts' }, ordinal: 0 },
        via: 'qwen3_coder',
      })
    }
  })

  it('coerces JSON-looking parameter values and leaves the rest as strings', () => {
    const out = merge(
      run(
        '<function=shell><parameter=command>ls -la</parameter><parameter=timeoutMs>5000</parameter></function>',
      ),
    )
    expect(out).toEqual([
      {
        type: 'toolcall_end',
        call: { toolUseId: 'dc-0', name: 'shell', args: { command: 'ls -la', timeoutMs: 5000 }, ordinal: 0 },
        via: 'qwen3_coder',
      },
    ])
  })

  // An undisclosed tool name is not promoted - it goes back out as text. This is the gate that keeps
  // the decoder from inventing a call the model was never offered.
  it('does not promote a call to a tool that was not disclosed', () => {
    const raw = '<function=rm_rf><parameter=path>/</parameter></function>'
    expect(merge(run(raw))).toEqual([{ type: 'text_delta', delta: raw }])
  })

  // In a thinking stream the same syntax is attributed to the reasoning field, not to the rule.
  it('attributes a call recovered from thinking to reasoning_field', () => {
    const out = merge(run('<function=read><parameter=path>a</parameter></function>', 'thinking'))
    expect(out).toEqual([
      {
        type: 'toolcall_end',
        call: { toolUseId: 'dc-0', name: 'read', args: { path: 'a' }, ordinal: 0 },
        via: 'reasoning_field',
      },
    ])
  })

  // Text that carried a call shape past every rule is the case a deviation exists to count: the
  // model tried, nothing parsed it, and the turn continues as prose. The hash is over the raw text
  // so two occurrences of the same failure are one sample.
  it('reports a call-shaped capture that nothing promoted as an unparsed deviation', () => {
    const raw = '<function=rm_rf><parameter=x>{"name": "read"}</parameter></function>'
    const out = merge(run(raw))
    expect(out).toEqual([
      { type: 'text_delta', delta: raw },
      { type: 'deviation', rule: 'unparsed', sampleHash: sha256Hex(raw) },
    ])
  })

  it('does not report a deviation for text that never looked like a call', () => {
    const raw = '<function=rm_rf><parameter=path>/</parameter></function>'
    expect(merge(run(raw)).filter((e) => e.type === 'deviation')).toEqual([])
  })

  // A capture cannot grow without bound. Past CAPTURE_MAX the opening tag and everything after it
  // leave as ordinary text and the capture is abandoned - so a closing tag arriving after the bound
  // is prose too, which is what tells this case apart from one that simply held on longer.
  it('gives up on a capture that outgrows CAPTURE_MAX, closing tag and all', () => {
    expect(CAPTURE_MAX).toBe(65_536)
    const raw = `<think>${'z'.repeat(85_536)}</think>tail`
    const out = merge(run(raw, 'text', 4096))
    expect(out.map((e) => e.type)).toEqual(['text_delta'])
    expect(out).toEqual([{ type: 'text_delta', delta: raw }])
  })

  // PARSER_VERSION is stamped into every format/deviation ledger row and was asserted nowhere.
  // Changing RULES without changing it makes past rows claim a parse they did not get.
  it('pins the rule order and the parser version together', () => {
    expect(RULES.map((r) => r.id)).toEqual([
      'think_tag',
      'qwen3_coder',
      'anthropic_invoke',
      'hermes_tool_call',
      'inline_json',
    ])
    expect(PARSER_VERSION).toBe('2')
  })
})

// The decode chain has to be reimplementable in another language against the same fixtures, so it
// carries its own digest rather than reaching for node:crypto. It has to agree with the node one.
describe('decode sha256', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('agrees with the node implementation on every length around a block boundary', () => {
    for (const text of [
      '',
      'a',
      'hello world',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(64),
      'x'.repeat(1000),
      'café — 中文',
    ])
      expect(sha256Hex(text), `len=${text.length}`).toBe(nodeSha256(text))
  })
})

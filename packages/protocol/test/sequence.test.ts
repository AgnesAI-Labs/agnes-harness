import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkSequence, type Frame, META_KEY } from '../src/index.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

const upd = (seq: number, phase: string, turn = '10'): Frame => ({
  dir: 'recv',
  msg: {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk' },
      _meta: {
        [META_KEY]: { promptTurnId: turn, eventSequence: seq, generation: 1, lane: 'main', phase },
      },
    },
  },
})
const prompt: Frame = {
  dir: 'send',
  msg: {
    jsonrpc: '2.0',
    id: 7,
    method: 'session/prompt',
    params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] },
  },
}
const resp: Frame = { dir: 'recv', msg: { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } } }

describe('checkSequence', () => {
  it('passes a well-formed turn', () => {
    const r = checkSequence(
      [prompt, upd(11, 'event'), upd(12, 'responseBoundary'), upd(13, 'terminalQuiescence'), resp],
      ['seq-monotonic', 'quiescence-last', 'prompt-response-after-quiescence'],
    )
    expect(r.ok, JSON.stringify(r.violations)).toBe(true)
  })
  it('flags a non-monotonic seq at the frame that repeats it', () => {
    const r = checkSequence(
      [prompt, upd(11, 'event'), upd(11, 'event'), upd(13, 'terminalQuiescence'), resp],
      ['seq-monotonic'],
    )
    expect(r.ok).toBe(false)
    expect(r.violations[0]).toMatchObject({ invariant: 'seq-monotonic', at: 2 })
  })
  it('flags quiescence not last, quiescence missing, and a response that came first', () => {
    expect(
      checkSequence([prompt, upd(11, 'terminalQuiescence'), upd(12, 'event'), resp], ['quiescence-last']).ok,
    ).toBe(false)
    expect(
      checkSequence(
        [prompt, upd(11, 'event'), resp, upd(12, 'terminalQuiescence')],
        ['prompt-response-after-quiescence'],
      ).ok,
    ).toBe(false)
    // Exactly once: zero terminalQuiescence rows is as much a violation as two.
    expect(checkSequence([prompt, upd(11, 'event'), resp], ['quiescence-last']).ok).toBe(false)
    expect(
      checkSequence(
        [prompt, upd(11, 'terminalQuiescence'), upd(12, 'terminalQuiescence'), resp],
        ['quiescence-last'],
      ).ok,
    ).toBe(false)
  })
  // The fourth phase value. A parked turn has no terminal quiescence, which is precisely the shape
  // that would make a lenient quiescence-last check green on an approval that never came back.
  it('a parked turn violates quiescence-last but not seq-monotonic', () => {
    const parked: Frame[] = [prompt, upd(11, 'event'), upd(12, 'parked')]
    const r = checkSequence(parked, ['quiescence-last'])
    expect(r.ok).toBe(false)
    // The detail matters: the violation has to be "there was no quiescence at all", not "something
    // came after it". A checker that only looks at position reports the second and would go green
    // the moment the zero case were handled separately.
    expect(r.violations[0]).toMatchObject({
      invariant: 'quiescence-last',
      detail: expect.stringContaining('count 0'),
    })
    expect(checkSequence(parked, ['seq-monotonic']).ok).toBe(true)
  })
  // A _meta with no eventSequence must be a violation, not a free pass: a `?? -1` fallback on the
  // first update compares smaller than everything after it and passes in silence.
  it('a missing eventSequence is a seq-monotonic violation, not a pass', () => {
    const noSeq: Frame = {
      dir: 'recv',
      msg: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'agent_message_chunk' },
          _meta: { [META_KEY]: { promptTurnId: '10', generation: 1, lane: 'main', phase: 'event' } },
        },
      },
    }
    const r = checkSequence([prompt, noSeq, upd(12, 'terminalQuiescence'), resp], ['seq-monotonic'])
    expect(r.ok).toBe(false)
    expect(r.violations[0]).toMatchObject({ invariant: 'seq-monotonic', at: 1, detail: 'no eventSequence' })
  })
  // prompt-response-after-quiescence has no meaning without a prompt frame, and matching "the first
  // id-less result frame" instead is a latent false positive. Refuse the input rather than guess.
  it('refuses to check prompt-response-after-quiescence without a prompt frame', () => {
    expect(() => checkSequence([upd(11, 'event'), resp], ['prompt-response-after-quiescence'])).toThrow(
      /session\/prompt frame/,
    )
    // The other two invariants have no such precondition and still work on the same input.
    expect(() => checkSequence([upd(11, 'event'), resp], ['seq-monotonic'])).not.toThrow()
  })
  // Frames that carry no harness meta, and frames going the other way, are not updates. Without
  // this the filter could drift to "any session/update" and start reading a client's own frames.
  it('ignores frames without harness meta and frames sent rather than received', () => {
    const bare: Frame = { dir: 'recv', msg: { jsonrpc: '2.0', method: 'session/update', params: {} } }
    const outbound: Frame = { ...upd(1, 'event'), dir: 'send' }
    const r = checkSequence(
      [prompt, bare, outbound, upd(11, 'event'), upd(12, 'terminalQuiescence'), resp],
      ['seq-monotonic', 'quiescence-last', 'prompt-response-after-quiescence'],
    )
    expect(r.ok, JSON.stringify(r.violations)).toBe(true)
  })
  it('the checked-in sequence fixtures agree with the checker', () => {
    const lines = readFileSync(
      new URL('../fixtures/sequences/meta-quiescence.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(4)
    for (const line of lines) {
      const f = JSON.parse(line) as Fixture
      expect(runFixtureLine(f).pass, f.id).toBe(true)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import {
  byteLength,
  CALL_OUTPUT_LIMIT_BYTES,
  type GuardedBlock,
  guardOutput,
  guardOutputSet,
  OUTPUT_LIMITS,
  refBlock,
} from '../src/guards/output.js'

const { maxBytes, maxLines, headBytes, tailBytes } = OUTPUT_LIMITS

describe('guardOutput', () => {
  it('passes small output through without touching the artifact store', async () => {
    const ctx = fakeToolContext()
    const r = await guardOutput(ctx, 'hello')
    expect(r).toEqual({ text: 'hello', truncated: false })
    expect(ctx.calls.artifacts).toHaveLength(0)
  })

  it('passes output that sits exactly on both limits', async () => {
    const ctx = fakeToolContext()
    const text = `${'x'.repeat(maxBytes - maxLines + 1)}${'\n'.repeat(maxLines - 1)}`
    expect(text.length).toBe(maxBytes)
    expect(text.split('\n')).toHaveLength(maxLines)
    expect((await guardOutput(ctx, text)).truncated).toBe(false)
    expect(ctx.calls.artifacts).toHaveLength(0)
  })

  it('spills over the character limit, keeping head and tail', async () => {
    const ctx = fakeToolContext()
    const big = 'x'.repeat(maxBytes + 1)
    const r = await guardOutput(ctx, big)
    expect(r.truncated).toBe(true)
    expect(r.ref?.size).toBe(big.length)
    expect(r.text.startsWith('x'.repeat(headBytes))).toBe(true)
    expect(r.text.endsWith('x'.repeat(tailBytes))).toBe(true)
    expect(r.text).toContain('[truncated')
    // Which limit was hit is part of the message, so the model is told why it lost the middle.
    expect(r.text).toContain(`over the ${maxBytes}-byte limit`)
    expect(r.text).not.toContain('line limit')
  })

  it('spills over the line limit even when the text is small, and says so', async () => {
    const ctx = fakeToolContext()
    // Short lines, so the character limit is nowhere near reached and only the line count can be
    // what triggered the spill.
    const r = await guardOutput(ctx, Array.from({ length: maxLines + 1 }, () => 'x').join('\n'))
    expect(r.truncated).toBe(true)
    expect(r.text).toContain(`over the ${maxLines}-line limit`)
    expect(r.text).not.toContain('character')
  })

  it('names both limits when both are exceeded', async () => {
    const ctx = fakeToolContext()
    const r = await guardOutput(ctx, `${'y'.repeat(maxBytes)}\n`.repeat(maxLines))
    expect(r.text).toContain(`over the ${maxBytes}-byte and ${maxLines}-line limits`)
  })

  it('never returns more text than it was given', async () => {
    // Head and tail are cut from the same string, so on a text shorter than head+tail they would
    // overlap and the "truncated" output would repeat the middle — longer than the original.
    const ctx = fakeToolContext()
    const many = '\n'.repeat(maxLines)
    const r = await guardOutput(ctx, many)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThan(many.length + 200)
    expect(r.text.replaceAll('\n', '').startsWith('[truncated')).toBe(true)
  })

  it('drops the middle rather than sampling it twice', async () => {
    const ctx = fakeToolContext()
    const text = `${'A'.repeat(headBytes)}${'B'.repeat(5000)}${'C'.repeat(tailBytes)}`
    const r = await guardOutput(ctx, text)
    expect(r.text).not.toContain('B')
    expect(r.text.startsWith('A'.repeat(headBytes))).toBe(true)
    expect(r.text.endsWith('C'.repeat(tailBytes))).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(headBytes + tailBytes + 200)
  })

  it('stores the whole text, not the truncated view', async () => {
    const ctx = fakeToolContext()
    const text = `${'A'.repeat(headBytes)}${'B'.repeat(5000)}${'C'.repeat(tailBytes)}`
    const r = await guardOutput(ctx, text)
    const stored = new TextDecoder().decode(ctx.calls.artifacts[0]?.bytes as Uint8Array)
    expect(stored).toBe(text)
    expect(ctx.calls.artifacts[0]?.mime).toBe('text/plain')
    expect(r.text).toContain(r.ref?.sha256.slice(0, 12) as string)
  })

  it('passes an explicit mime through to the artifact store', async () => {
    const ctx = fakeToolContext()
    await guardOutput(ctx, 'z'.repeat(maxBytes + 1), { mime: 'text/x-diff' })
    expect(ctx.calls.artifacts[0]?.mime).toBe('text/x-diff')
  })

  it('does not split a surrogate pair at the head or tail boundary', async () => {
    const ctx = fakeToolContext()
    // An emoji straddling the head cut and another straddling the tail cut.
    const text = `${'a'.repeat(headBytes - 1)}😀${'b'.repeat(5000)}😀${'c'.repeat(tailBytes - 1)}`
    const r = await guardOutput(ctx, text)
    for (const code of [...r.text].map((c) => c.codePointAt(0) as number))
      expect(code < 0xd800 || code > 0xdfff).toBe(true)
  })

  it('still truncates when the artifact store fails, and says the text was not stored', async () => {
    // Failing open here would put the whole unbounded output into the model's context, which is the
    // one thing this guard exists to prevent.
    const ctx = fakeToolContext({ artifactsFail: 'artifact store offline' })
    const big = 'x'.repeat(maxBytes + 1)
    const r = await guardOutput(ctx, big)
    expect(r.truncated).toBe(true)
    expect(r.ref).toBeUndefined()
    expect(r.text.length).toBeLessThanOrEqual(headBytes + tailBytes + 200)
    expect(r.text).toContain('could not be stored')
    expect(r.text).toContain('artifact store offline')
  })

  it('cuts a huge store failure message instead of letting the note grow past the limits', async () => {
    // The note is the only part of a guarded result no limit applies to, and the message inside it
    // is written by whichever backend just failed. Uncut, a storage outage becomes the unbounded
    // context this guard exists to prevent.
    const ctx = fakeToolContext({ artifactsFail: `store offline ${'m'.repeat(100 * 1024)}` })
    const r = await guardOutput(ctx, 'x'.repeat(maxBytes + 1))
    expect(r.text.length).toBeLessThanOrEqual(headBytes + tailBytes + 400)
    // The message is cut, not dropped: the reason for the failure still reaches the model.
    expect(r.text).toContain('store offline')
  })

  // A rejection from an artifact backend is an arbitrary value, not necessarily an Error. These
  // three shapes make the conversion to text throw, and the guard is called outside every `try` in
  // the tools, so a throw here leaves `execute()` and ends the turn — on the exact path taken when
  // storage is already failing.
  const refuseToConvert = (): never => {
    throw new Error('nope')
  }
  const hostile: [string, () => unknown][] = [
    ['a null-prototype rejection', () => Object.create(null)],
    ['a rejection whose Symbol.toPrimitive throws', () => ({ [Symbol.toPrimitive]: refuseToConvert })],
    ['a rejection whose toString throws', () => ({ toString: refuseToConvert })],
  ]

  for (const [what, make] of hostile)
    it(`describes ${what} instead of throwing out of the guard`, async () => {
      const ctx = fakeToolContext()
      ctx.artifacts.put = () => Promise.reject(make())
      const r = await guardOutput(ctx, 'x'.repeat(maxBytes + 1))
      expect(r.truncated).toBe(true)
      expect(r.ref).toBeUndefined()
      expect(r.text).toContain('could not be stored')
      expect(r.text.length).toBeLessThanOrEqual(headBytes + tailBytes + 400)
    })

  it('does not leave a lone surrogate in the cut store failure message', async () => {
    // The message is cut at a fixed code-unit count like the head and the tail are, so it needs the
    // same trimming: a cut landing inside a surrogate pair leaves a half that is not valid text.
    // Every offset mod 2 is covered, so the cut lands both between pairs and inside one.
    const messages = [
      ...[0, 1, 2, 3].map((pad) => `${'p'.repeat(pad)}${'\u{1f600}'.repeat(500)}`),
      '\ud800',
      '\udc00',
    ]
    for (const m of messages) {
      const ctx = fakeToolContext({ artifactsFail: m })
      const r = await guardOutput(ctx, 'x'.repeat(maxBytes + 1))
      for (const code of [...r.text].map((c) => c.codePointAt(0) as number))
        expect(code < 0xd800 || code > 0xdfff, JSON.stringify(m.slice(0, 8))).toBe(true)
    }
  })

  it('keeps the limits at the documented values', () => {
    expect(OUTPUT_LIMITS).toEqual({ maxBytes: 8192, maxLines: 2000, headBytes: 4096, tailBytes: 1024 })
  })
})

describe('refBlock', () => {
  it('builds a ref content block, defaulting the mime to the artifact mime', async () => {
    const ctx = fakeToolContext()
    const ref = await ctx.artifacts.put(new TextEncoder().encode('x'), { mime: 'text/plain' })
    expect(refBlock(ref)).toEqual({ type: 'ref', ref, mime: 'text/plain' })
    expect(refBlock(ref, 'text/x-diff').mime).toBe('text/x-diff')
  })
})

describe('guardOutput measures bytes, not UTF-16 code units', () => {
  // A limit counted in code units lets a CJK result through at about three times the payload an
  // ASCII one gets, because each CJK character is three UTF-8 bytes and each ASCII character is
  // one. Bytes are also the better stand-in for what the limit is really protecting — tokens —
  // since characters-per-token swings by script while bytes-per-token barely moves.
  it('truncates CJK and ASCII at the same real size', async () => {
    const ctx = fakeToolContext()
    const cjkOverBudget = '中'.repeat(Math.ceil(maxBytes / 3) + 10)
    const asciiSameCount = 'a'.repeat(cjkOverBudget.length)
    expect(Buffer.byteLength(cjkOverBudget, 'utf8')).toBeGreaterThan(maxBytes)
    expect(Buffer.byteLength(asciiSameCount, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect((await guardOutput(ctx, cjkOverBudget)).truncated).toBe(true)
    expect((await guardOutput(ctx, asciiSameCount)).truncated).toBe(false)
  })

  it('never cuts a multi-byte character in half', async () => {
    const ctx = fakeToolContext()
    const r = await guardOutput(ctx, '中'.repeat(maxBytes))
    expect(r.truncated).toBe(true)
    // A byte-level cut landing mid-character would leave U+FFFD once the string is read back.
    expect(r.text).not.toContain('�')
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(maxBytes)
  })
})

describe('guardOutput does not eat a byte-order mark', () => {
  // TextDecoder defaults to ignoreBOM:false, which strips a leading EF BB BF from *every* decode
  // call rather than only from a genuine document start. Both cuts decode from byte 0 of their
  // subarray, so without the flag a truncated Windows-authored file silently loses its first
  // character -- the same class of quiet rewrite the envelope scrub exists to prevent.
  it('keeps a leading U+FEFF through truncation', async () => {
    const ctx = fakeToolContext()
    const text = `﻿${'a'.repeat(maxBytes + 8)}`
    const r = await guardOutput(ctx, text)
    expect(r.truncated).toBe(true)
    expect(r.text.charCodeAt(0)).toBe(0xfeff)
  })

  it('keeps a U+FEFF sitting at the first byte the tail cut keeps', async () => {
    const ctx = fakeToolContext()
    // Build the text first, then compute where cutTail will actually start from its real byte
    // length -- inserting the mark shifts everything after it, so deriving the offset from the
    // pre-insertion length puts the mark in the discarded middle instead, where losing it is
    // correct behaviour rather than the bug.
    const filler = `${'a'.repeat(maxBytes)}${'b'.repeat(500)}`
    const withMark = (at: number) => `${filler.slice(0, at)}\ufeff${filler.slice(at)}`
    let text = withMark(0)
    for (let i = 0; i < 4; i++) {
      const start = Math.max(headBytes, byteLength(text) - tailBytes)
      text = withMark(start)
      if (byteLength(text) - tailBytes <= start) break
    }
    const r = await guardOutput(ctx, text)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('\ufeff')
  })
})

describe('guardOutputSet', () => {
  it('keeps the call limit at its documented value', () => {
    expect(CALL_OUTPUT_LIMIT_BYTES).toBe(32 * 1024)
  })

  it('passes a small set through untouched, without spending the artifact store', async () => {
    const ctx = fakeToolContext()
    const input: GuardedBlock[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ]
    const out = await guardOutputSet(ctx, input)
    expect(out).toEqual({
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
      omitted: 0,
    })
    expect(ctx.calls.artifacts).toHaveLength(0)
  })

  it('bounds the sum across blocks, not just each one', async () => {
    const ctx = fakeToolContext()
    // Ten blocks of 7KB: every one is under the single-block limit on its own, but their sum
    // (70KB) is well over the 32KB call limit, so a per-block-only check would let all of them
    // through -- exactly the shape an MCP server wrapping a database returns as "many rows".
    const input: GuardedBlock[] = Array.from({ length: 10 }, () => ({
      kind: 'text' as const,
      text: 'a'.repeat(7 * 1024),
    }))
    const out = await guardOutputSet(ctx, input)
    const total = out.blocks.reduce((n, b) => n + (b.type === 'text' ? byteLength(b.text) : 0), 0)
    expect(total).toBeLessThanOrEqual(CALL_OUTPUT_LIMIT_BYTES)
    expect(out.omitted).toBeGreaterThan(0)
    // The full ten blocks are still reachable -- hitting the call limit loses the inline view,
    // not the data.
    expect(out.ref).toBeDefined()
  })

  it('charges the budget for passthrough blocks too, the gap codex leaves open', async () => {
    const ctx = fakeToolContext()
    // A passthrough block (already converted to an artifact ref, e.g. an MCP image) that alone
    // spends the whole call budget must still block a smaller text block from slipping in after
    // it. A budget that only charges text blocks is not really a budget: codex bounds its text
    // items exactly this way and lets image and encrypted blocks through for free.
    const input: GuardedBlock[] = [
      {
        kind: 'passthrough',
        bytes: CALL_OUTPUT_LIMIT_BYTES,
        content: { type: 'text', text: 'spends it all' },
      },
      { kind: 'text', text: 'a'.repeat(1024) },
    ]
    const out = await guardOutputSet(ctx, input)
    expect(out.blocks).toContainEqual({ type: 'text', text: 'spends it all' })
    expect(out.blocks.some((b) => b.type === 'text' && b.text === 'a'.repeat(1024))).toBe(false)
    expect(out.omitted).toBe(1)
  })

  it('drops a block that cannot be afforded and everything after it, keeping order', async () => {
    const ctx = fakeToolContext()
    // Declared costs rather than text, so the numbers are exact and not entangled with guardOutput's
    // own head/tail truncation of an oversized text block.
    const spend = (bytes: number, tag: string): GuardedBlock => ({
      kind: 'passthrough',
      bytes,
      content: { type: 'text', text: tag },
    })
    const input: GuardedBlock[] = [
      spend(CALL_OUTPUT_LIMIT_BYTES - 100, 'first'),
      spend(200, 'second'), // only 100 bytes of budget remain -- does not fit
      spend(50, 'third'), // would fit alone, but arrives after the budget is already spent
    ]
    const out = await guardOutputSet(ctx, input)
    expect(out.blocks).toContainEqual({ type: 'text', text: 'first' })
    expect(out.blocks.some((b) => b.type === 'text' && (b.text === 'second' || b.text === 'third'))).toBe(
      false,
    )
    expect(out.omitted).toBe(2)
  })

  it('charges a text block its truncated size, not its original size', async () => {
    const ctx = fakeToolContext()
    // A block already cut down to a few KB by its own single-block guard should spend the
    // aggregate budget as that few KB, not as the far larger size it arrived at.
    const input: GuardedBlock[] = [{ kind: 'text', text: 'x'.repeat(maxBytes * 10) }]
    const out = await guardOutputSet(ctx, input)
    expect(out.omitted).toBe(0)
    const textBlock = out.blocks.find((b) => b.type === 'text')
    expect(textBlock).toBeDefined()
    expect(byteLength((textBlock as { text: string }).text)).toBeLessThan(headBytes + tailBytes + 200)
  })

  it('still bounds the result when the full-set artifact store is unavailable', async () => {
    const ctx = fakeToolContext({ artifactsFail: 'set store offline' })
    const input: GuardedBlock[] = Array.from({ length: 10 }, () => ({
      kind: 'text' as const,
      text: 'a'.repeat(7 * 1024),
    }))
    const out = await guardOutputSet(ctx, input)
    expect(out.omitted).toBeGreaterThan(0)
    expect(out.ref).toBeUndefined()
    const note = out.blocks.find((b) => b.type === 'text' && b.text.includes('could not be stored'))
    expect(note).toBeDefined()
    expect((note as { text: string }).text).toContain('set store offline')
  })
})

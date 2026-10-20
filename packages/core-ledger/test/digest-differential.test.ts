import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as node from '@agnes/core-common/request/sha256-node'
import * as portable from '@agnes/core-common/request/sha256-portable'
import type { Event, SessionKey } from '@agnes/core-common/types'
import { jcs, jcsWrite } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  type IntegrityState,
  LEDGER_INTEGRITY_ALGORITHM,
  prepareIntegrity,
  verifyIntegrityRows,
} from '../src/log/integrity.js'
import { digestWith, random, values } from './helpers/digest-values.js'
import { jcsReference } from './helpers/jcs-reference.js'

const NIST: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
]

const repo = fileURLToPath(new URL('../../..', import.meta.url))
function fixtureLines(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.jsonl') && path.includes(`${sep}fixtures${sep}`))
        out.push(...readFileSync(path, 'utf8').split('\n').filter(Boolean))
    }
  }
  walk(join(repo, 'packages'))
  return out
}

/**
 * Random UTF-16 text drawn code unit by code unit: ASCII, every C0 control and DEL, two- and
 * three-byte UTF-8 ranges, the JSON-significant line separators, noncharacters, astral pairs and
 * (when `lone` is set) unpaired high and low surrogates in any position.
 */
function randomText(next: () => number, length: number, lone: boolean): string {
  const units: number[] = []
  const pick = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  while (units.length < length) {
    const r = next()
    if (r < 0.25) units.push(pick(0x20, 0x7e))
    else if (r < 0.4) units.push(pick(0x00, 0x1f))
    else if (r < 0.43) units.push(next() < 0.5 ? 0x7f : pick(0x80, 0x9f))
    else if (r < 0.5) units.push(pick(0xa0, 0x7ff))
    else if (r < 0.6) units.push(pick(0x800, 0xd7ff))
    else if (r < 0.65) units.push([0x2028, 0x2029, 0xfeff, 0xfffd, 0xfffe, 0xffff][pick(0, 5)] as number)
    else if (r < 0.7) units.push(pick(0xe000, 0xfffd))
    else if (r < 0.85) {
      const cp = pick(0x10000, 0x10ffff) - 0x10000
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else if (lone && r < 0.93) units.push(pick(0xd800, 0xdbff))
    else if (lone) units.push(pick(0xdc00, 0xdfff))
    else units.push(0x22, 0x5c)
  }
  return String.fromCharCode(...units)
}

/** A random JSON value whose every string (keys included) comes from `randomText`. */
function randomValue(next: () => number, lone: boolean, depth = 0): unknown {
  const r = next()
  const text = () => randomText(next, Math.floor(next() * 40), lone)
  if (depth > 4 || r < 0.35) return text()
  if (r < 0.45) return (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20)
  if (r < 0.5) return next() < 0.5 ? null : next() < 0.5
  if (r < 0.75)
    return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, lone, depth + 1))
  return Object.fromEntries(
    Array.from({ length: Math.floor(next() * 5) }, () => [text(), randomValue(next, lone, depth + 1)]),
  )
}

const outcome = (fn: () => string): string | Error => {
  try {
    return fn()
  } catch (error) {
    return error as Error
  }
}

describe('sha256 implementations', () => {
  it('match the NIST vectors in both implementations', () => {
    for (const [input, digest] of NIST) {
      expect(node.sha256Hex(input)).toBe(digest)
      expect(portable.sha256Hex(input)).toBe(digest)
      const n = node.createSha256()
      const p = portable.createSha256()
      for (let i = 0; i < input.length; i += 4097) {
        n.update(input.slice(i, i + 4097))
        p.update(input.slice(i, i + 4097))
      }
      expect([n.digestHex(), p.digestHex()]).toEqual([digest, digest])
    }
  })

  it('agree on bytes, lone surrogates and the counted UTF-8 length', () => {
    for (const s of ['\ud800', 'a\udc00b', '你好😀', '']) {
      expect(node.sha256Hex(s)).toBe(portable.sha256Hex(s))
      const n = node.createSha256()
      const p = portable.createSha256()
      n.update(s)
      p.update(s)
      expect(n.bytes).toBe(new TextEncoder().encode(s).byteLength)
      expect(p.bytes).toBe(n.bytes)
    }
    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    expect(node.sha256Hex(bytes)).toBe(portable.sha256Hex(bytes))
  })

  it('declare which implementation they are', () => {
    expect([node.SHA256_IMPLEMENTATION, portable.SHA256_IMPLEMENTATION]).toEqual(['node', 'portable'])
  })

  it('resolve to node:crypto through #sha256 under Node', async () => {
    const hash = await import('@agnes/core-common/request/hash')
    expect(hash.SHA256_IMPLEMENTATION).toBe('node')
    expect(hash.createSha256).toBe(node.createSha256)
  })

  it('agree on every length across the padding boundaries', () => {
    for (let n = 0; n <= 200; n++) {
      const text = 'é'.repeat(n >> 1) + 'a'.repeat(n & 1)
      expect(node.sha256Hex(text)).toBe(portable.sha256Hex(text))
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      expect(node.sha256Hex(bytes)).toBe(portable.sha256Hex(bytes))
    }
  })

  it('agree on 2000 random strings with lone surrogates, controls and astral characters', () => {
    const next = random(7)
    const encoder = new TextEncoder()
    for (let i = 0; i < 2000; i++) {
      const text = randomText(next, Math.floor(next() * 300), true)
      expect(node.sha256Hex(text)).toBe(portable.sha256Hex(text))
      // Whatever the chunking, both streams hash the same bytes and count the same length as a
      // one-shot TextEncoder pass over each chunk.
      const n = node.createSha256()
      const p = portable.createSha256()
      let expected = 0
      for (let at = 0; at < text.length; ) {
        const end = at + 1 + Math.floor(next() * 40)
        const chunk = next() < 0.2 ? encoder.encode(text.slice(at, end)) : text.slice(at, end)
        n.update(chunk)
        p.update(chunk)
        expected += typeof chunk === 'string' ? encoder.encode(chunk).byteLength : chunk.byteLength
        at = end
      }
      expect(n.bytes).toBe(expected)
      expect(p.bytes).toBe(expected)
      expect(n.digestHex()).toBe(p.digestHex())
    }
  })

  it('give the one-shot digest when a well-formed string is fed in code-point-aligned chunks', () => {
    const next = random(11)
    for (let i = 0; i < 500; i++) {
      const text = randomText(next, Math.floor(next() * 500), false)
      const whole = portable.sha256Hex(text)
      const points = [...text]
      const n = node.createSha256()
      const p = portable.createSha256()
      for (let at = 0; at < points.length; ) {
        const end = at + 1 + Math.floor(next() * 30)
        const chunk = points.slice(at, end).join('')
        n.update(chunk)
        p.update(chunk)
        at = end
      }
      expect([n.digestHex(), p.digestHex()]).toEqual([whole, whole])
      expect(n.bytes).toBe(new TextEncoder().encode(text).byteLength)
    }
  })

  it('agree on 300 random byte arrays fed in random slices', () => {
    const next = random(13)
    for (let i = 0; i < 300; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(next() * 5000) }, () => Math.floor(next() * 256))
      const n = node.createSha256()
      const p = portable.createSha256()
      for (let at = 0; at < bytes.length; ) {
        const end = at + 1 + Math.floor(next() * 700)
        n.update(bytes.subarray(at, end))
        p.update(bytes.subarray(at, end))
        at = end
      }
      const whole = portable.sha256Hex(bytes)
      expect([n.digestHex(), p.digestHex(), node.sha256Hex(bytes)]).toEqual([whole, whole, whole])
      expect([n.bytes, p.bytes]).toEqual([bytes.length, bytes.length])
    }
  })
})

describe('canonical digest differential', () => {
  it('produces identical bytes and digests for every fixture ledger line', () => {
    const lines = fixtureLines()
    expect(lines.length).toBeGreaterThan(1000)
    for (const line of lines) {
      const value = JSON.parse(line) as unknown
      let reference: string | Error
      try {
        reference = jcsReference(value)
      } catch (error) {
        reference = error as Error
      }
      if (reference instanceof Error) {
        expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
        continue
      }
      expect(jcs(value)).toBe(reference)
      expect(digestWith(node, value)).toBe(portable.sha256Hex(reference))
      expect(digestWith(portable, value)).toBe(node.sha256Hex(reference))
    }
  })

  // The heavy project runs 3000 of these; a few hundred here keep some 70k strings in every fast run.
  it('agrees on 300 generated values (ASCII, CJK, four-byte, empty, escapes, deep nesting, 70k strings)', () => {
    const gen = values(20261013)
    for (let i = 0; i < 300; i++) {
      const value = gen.next().value
      const reference = jcsReference(value)
      expect(jcs(value)).toBe(reference)
      expect(digestWith(node, value)).toBe(digestWith(portable, value))
      expect(digestWith(node, value)).toBe(portable.sha256Hex(reference))
    }
  })

  it('rejects the same invalid inputs as before', () => {
    for (const value of ['\ud800', '\udc00', '\ud800a', { k: '\udfff' }, ['\ud83d']])
      for (const fn of [() => jcs(value), () => jcsReference(value)])
        expect(fn).toThrow(/^invalid JCS input$/)
  })

  it('agrees on single large strings up to 8 MiB', () => {
    for (const size of [0, 1, 65_535, 65_536, 1 << 20, 8 << 20]) {
      const value = { event: { data: { content: [{ type: 'image', data: 'QUJD'.repeat(size >> 2) }] } } }
      expect(digestWith(node, value)).toBe(portable.sha256Hex(jcsReference(value)))
    }
  })

  it('accepts and rejects exactly what the reference does on 3000 random values with lone surrogates', () => {
    const next = random(20261014)
    let rejected = 0
    let accepted = 0
    for (let i = 0; i < 3000; i++) {
      const value = randomValue(next, true)
      const reference = outcome(() => jcsReference(value))
      if (reference instanceof Error) {
        rejected++
        expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
        expect(() => jcsWrite(value, () => {})).toThrow(/^invalid JCS input$/)
        continue
      }
      accepted++
      expect(jcs(value)).toBe(reference)
      expect(digestWith(node, value)).toBe(portable.sha256Hex(reference))
      expect(digestWith(portable, value)).toBe(node.sha256Hex(reference))
    }
    // Both branches carry weight: a generator that never produced one side would prove nothing.
    expect(Math.min(rejected, accepted)).toBeGreaterThan(300)
  })

  it('agrees on 2000 random well-formed values built from every code-unit class', () => {
    const next = random(20261015)
    for (let i = 0; i < 2000; i++) {
      const value = randomValue(next, false)
      const reference = jcsReference(value)
      expect(jcs(value)).toBe(reference)
      expect(digestWith(node, value)).toBe(portable.sha256Hex(reference))
      expect(digestWith(portable, value)).toBe(node.sha256Hex(reference))
    }
  })

  it('rejects a lone surrogate wherever it sits in a string or a key', () => {
    for (const lone of ['\ud800', '\udbff', '\udc00', '\udfff']) {
      for (const text of [lone, `a${lone}`, `${lone}a`, `😀${lone}😀`, `${'x'.repeat(70_000)}${lone}`]) {
        for (const value of [text, { [text]: 1 }, { k: [text] }, [1, { a: text }]]) {
          expect(() => jcsReference(value)).toThrow(/^invalid JCS input$/)
          expect(() => jcs(value)).toThrow(/^invalid JCS input$/)
        }
      }
    }
    // A reversed pair is two lone surrogates.
    expect(() => jcs('\udc00\ud800')).toThrow(/^invalid JCS input$/)
    expect(jcs('𐀀')).toBe(jcsReference('𐀀'))
  })
})

describe('ledger digest path', () => {
  const key = 'differential-session' as SessionKey
  const encoder = new TextEncoder()

  /** The ledger digests as the code before node:crypto and chunked serialization computed them. */
  function referenceChain(events: readonly Event[], legacyThroughSeq: number) {
    let previous: string | null = null
    let canonicalBytes = 0
    const digests: string[] = []
    for (const event of events) {
      const envelope =
        previous === null
          ? { algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey: key, legacyThroughSeq, event }
          : { algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey: key, previousDigest: previous, event }
      const canonical = jcsReference(envelope)
      canonicalBytes += encoder.encode(canonical).byteLength
      previous = portable.sha256Hex(canonical)
      digests.push(previous)
    }
    return { digests, canonicalBytes }
  }

  function check(events: Event[], legacyThroughSeq = 0) {
    const initial: IntegrityState = { lastSeq: legacyThroughSeq, legacyThroughSeq, headDigest: null }
    const reference = referenceChain(events, legacyThroughSeq)
    const prepared = prepareIntegrity(key, events, initial)
    expect(prepared.entries.map((entry) => entry.digest)).toEqual(reference.digests)
    expect(prepared.canonicalBytes).toBe(reference.canonicalBytes)
    // Rows stamped with the reference digests verify under the new path.
    const rows = events.map((event, i) => ({
      sessionKey: key,
      event,
      integrity: {
        mode: i === 0 ? ('anchor' as const) : ('chain' as const),
        previousDigest: i === 0 ? null : (reference.digests[i - 1] as string),
        digest: reference.digests[i] as string,
      },
    }))
    expect(verifyIntegrityRows(rows, initial).headDigest).toBe(reference.digests.at(-1) ?? null)
  }

  const asEvents = (items: readonly unknown[], from: number): Event[] =>
    items.map((item, i) => {
      const seq = from + i + 1
      return (
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? { ...(item as object), seq }
          : { seq, value: item }
      ) as Event
    })

  it('stamps every fixture ledger line with the digest the old path computed', () => {
    const items = fixtureLines()
      .map((line) => JSON.parse(line) as unknown)
      .filter((item) => !(outcome(() => jcsReference(item)) instanceof Error))
    expect(items.length).toBeGreaterThan(1000)
    for (let at = 0; at < items.length; at += 250) check(asEvents(items.slice(at, at + 250), 0))
    check(asEvents(items.slice(0, 50), 7), 7)
  })

  it('stamps generated values, including long strings and many small tokens, identically', () => {
    const gen = values(20261016)
    const next = random(20261017)
    const items: unknown[] = []
    for (let i = 0; i < 200; i++) items.push(gen.next().value, randomValue(next, false))
    for (let at = 0; at < items.length; at += 100) check(asEvents(items.slice(at, at + 100), 0))
  })

  it('stamps values that straddle the 64 KiB coalescing boundary identically', () => {
    const items: unknown[] = []
    for (const size of [65_534, 65_535, 65_536, 65_537, 131_072, 200_000])
      items.push(
        { data: 'A'.repeat(size) },
        { before: 'é'.repeat(size >> 1), data: '😀'.repeat(size >> 2), after: ['x', 1] },
        { many: Array.from({ length: size >> 3 }, (_, i) => (i % 3 ? i : `s${i}`)) },
        { mixed: Array.from({ length: 40 }, (_, i) => (i % 2 ? 'b'.repeat(size >> 4) : { k: i })) },
      )
    check(asEvents(items, 0))
  })

  it('stamps strings over the 1 MiB slice size identically, with a surrogate pair on the cut', () => {
    const slice = 1024 * 1024
    // The token starts with its opening quote, so this puts a high surrogate on the last unit of the
    // first slice; cutting there would hash two replacement characters instead of the pair.
    const straddle = `${'a'.repeat(slice - 2)}${'😀'.repeat(4)}b`
    check(
      asEvents(
        [
          { data: straddle },
          { data: `x${straddle}` },
          { data: '😀'.repeat(slice + 3), next: '𝄞'.repeat(slice >> 1) },
          { data: 'QUJD'.repeat(slice) },
        ],
        0,
      ),
    )
  })

  it('maps a lone surrogate in a stored event to the canonicalization failure, as before', () => {
    const event = { seq: 1, type: 'x', data: 'a\ud800' } as unknown as Event
    expect(() =>
      verifyIntegrityRows([
        {
          sessionKey: key,
          event,
          integrity: { mode: 'anchor', previousDigest: null, digest: '0'.repeat(64) },
        },
      ]),
    ).toThrow('stored event cannot be canonicalized')
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DECODE_FIXTURE_FILES,
  DECODE_SPLITS,
  loadDecodeFixtures,
  runDecodeFixture,
} from '../src/decode/fixtures.js'

const dir = fileURLToPath(new URL('../fixtures/decode/', import.meta.url))
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
const fixtures = files.flatMap((f) =>
  loadDecodeFixtures(readFileSync(join(dir, f), 'utf8')).map((x) => ({ ...x, file: f })),
)

describe('decode fixtures', () => {
  // A registry check, not a headcount. What it catches is a fixture file added to the directory and
  // never registered, which a runner in another language would then never read - the corpus would
  // look complete on this side and be short on the other.
  it('every fixture file on disk is registered', () => {
    expect(files).toEqual([...DECODE_FIXTURE_FILES])
  })

  it('every case declares where it came from and has a unique id', () => {
    for (const f of fixtures) expect(['hand-written', 'captured'], f.id).toContain(f.provenance)
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
  })

  // Registered, not hidden: none of these cases came off a real model, so the corpus states what the
  // rules were written to read rather than what a model actually writes. fixtures/decode/README.md
  // says who owes the captured samples and when.
  it('records that the corpus is still entirely hand-written', () => {
    expect(fixtures.filter((f) => f.provenance === 'captured')).toEqual([])
  })

  // The runner's verdict has to mean the same thing as the assertion beside it. A comparison over
  // serialised forms does not: two event lists that differ only in the order their keys were written
  // are equal events and unequal strings, so a runner using one and a test using the other would
  // disagree about the same fixture - green here, red in a runner reading the same files.
  it('the runner ignores key order, as a deep comparison does', () => {
    const reordered = {
      id: 'key-order',
      provenance: 'hand-written',
      tool_names: [],
      input_chunks: ['plain'],
      expected_events: [{ delta: 'plain', type: 'text_delta' }],
    } as unknown as Parameters<typeof runDecodeFixture>[0]
    const r = runDecodeFixture(reordered, 1)
    expect(r.got).toEqual(r.want)
    expect(r.pass).toBe(true)
  })

  describe.each(fixtures.map((f) => [`${f.file}#${f.id}`, f] as const))('%s', (_name, f) => {
    it.each([...DECODE_SPLITS])('split=%d', (split) => {
      const r = runDecodeFixture(f, split)
      expect(r.got, JSON.stringify(r.got)).toEqual(r.want)
      // The runner's own verdict, which a caller outside vitest reads instead of an assertion. It
      // has to agree with the line above, or a fixture could be green here and red in a Python
      // runner reading the same files.
      expect(r.pass).toBe(true)
    })
  })
})

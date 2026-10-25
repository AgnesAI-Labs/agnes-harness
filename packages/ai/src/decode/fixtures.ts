import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { createState, finish, mergeDeltas, step } from './machine.js'
import type { DecodeContext } from './types.js'

export type FixtureChunk =
  | string
  | { kind: 'thinking'; delta: string }
  | { kind: 'native_toolcall'; call: ToolCall }

export type DecodeFixture = {
  id: string
  /** `hand-written` or `captured`. A corpus that cannot say which is a corpus nobody can weigh. */
  provenance: 'hand-written' | 'captured'
  /** Which model produced a captured sample. Carried, not read: nothing routes a case by it. */
  model_hint?: string
  tool_names: string[]
  input_chunks: FixtureChunk[]
  expected_events: InferenceEvent[]
}

/**
 * The corpus, by name. A runner in another language reads this list rather than the directory, so
 * that adding a file and forgetting to register it is a failure here instead of a case that half
 * the implementations never run. decode-fixtures.test.ts holds it to what is on disk.
 */
export const DECODE_FIXTURE_FILES = [
  '01-native-passthrough.jsonl',
  '02-reasoning-field.jsonl',
  '03-think-tag.jsonl',
  '04-qwen3-coder.jsonl',
  '05-anthropic-invoke.jsonl',
  '06-hermes.jsonl',
  '07-inline-json.jsonl',
  '08-lenient-json.jsonl',
  '09-unparsed.jsonl',
  '10-gates.jsonl',
] as const

/** The chunk sizes every case is run at: single characters, three awkward sizes, and all at once. */
export const DECODE_SPLITS = [1, 2, 5, 13, 1000] as const

export function loadDecodeFixtures(text: string): DecodeFixture[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecodeFixture)
}

/**
 * Structural equality, written out because the comparison has to ignore the order object keys were
 * written in. Comparing serialised forms instead would let a runner call a case failed for a
 * difference the events do not have, and a test using a key-insensitive matcher beside it would
 * disagree with the runner about the same fixture.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const kx = Object.keys(x).filter((k) => x[k] !== undefined)
  const ky = Object.keys(y).filter((k) => y[k] !== undefined)
  return kx.length === ky.length && kx.every((k) => k in y && deepEqual(x[k], y[k]))
}

/**
 * One case at one chunk size. The tool-call ordinals are drawn from a single counter shared by the
 * native calls and the recovered ones, because they number the calls of one turn and a reader has to
 * be able to put them in order without knowing how each was carried.
 */
export function runDecodeFixture(
  f: DecodeFixture,
  split: number,
): { pass: boolean; got: InferenceEvent[]; want: InferenceEvent[] } {
  let ordinal = 0
  const ctx: DecodeContext = { toolNames: f.tool_names, nextOrdinal: () => ordinal++ }
  let state = createState()
  const got: InferenceEvent[] = []
  for (const chunk of f.input_chunks) {
    if (typeof chunk !== 'string' && chunk.kind === 'native_toolcall') {
      const fl = finish(state, ctx)
      state = fl.state
      got.push(...fl.events)
      got.push({ type: 'toolcall_end', call: { ...chunk.call, ordinal: ordinal++ }, via: 'native' })
      continue
    }
    const kind = typeof chunk === 'string' ? 'text' : 'thinking'
    const text = typeof chunk === 'string' ? chunk : chunk.delta
    for (let i = 0; i < text.length; i += split) {
      const r = step(state, { kind, delta: text.slice(i, i + split) }, ctx)
      state = r.state
      got.push(...r.events)
    }
  }
  got.push(...finish(state, ctx).events)
  const merged = mergeDeltas(got)
  return { pass: deepEqual(merged, f.expected_events), got: merged, want: f.expected_events }
}

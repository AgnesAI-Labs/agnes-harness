import { expect, it } from 'vitest'
import { guardOutput, readLimits } from '../src/index.js'

const preset = (over: Record<string, unknown> = {}) => ({
  code_runtime: { language: 'python', state: 'persistent', ...over },
})
it('uses actual omitted-field defaults and exact explicit overrides', () => {
  expect(readLimits(preset())).toEqual({
    language: 'python',
    wallMs: 600000,
    maxOutputChars: 65536,
    maxParallelSubCalls: 4,
  })
  expect(
    readLimits(
      preset({
        language: 'typescript',
        cell_timeout_ms: 1000,
        max_output_chars: 1024,
        max_parallel_sub_calls: 32,
      }),
    ),
  ).toEqual({ language: 'typescript', wallMs: 1000, maxOutputChars: 1024, maxParallelSubCalls: 32 })
})
it.each([
  undefined,
  null,
  [],
  'python',
  { language: 'python' },
  { language: 'constructor', state: 'persistent' },
])('rejects invalid runtime configuration %j', (block) => {
  expect(() => readLimits({ code_runtime: block })).toThrow('E_PRESET_UNSUPPORTED')
})
it.each([
  ['cell_timeout_ms', 999],
  ['cell_timeout_ms', '1000'],
  ['cell_timeout_ms', null],
  ['cell_timeout_ms', NaN],
  ['cell_timeout_ms', Infinity],
  ['cell_timeout_ms', 2 ** 53],
  ['max_output_chars', 1023],
  ['max_output_chars', 1024.5],
  ['max_parallel_sub_calls', 0],
  ['max_parallel_sub_calls', 33],
  ['max_parallel_sub_calls', false],
] as const)('refuses invalid %s=%j without coercion or default fallback', (key, value) => {
  expect(() => readLimits(preset({ [key]: value }))).toThrow('E_PRESET_UNSUPPORTED')
})
it('does not inherit a language declaration from a prototype', () => {
  const block = Object.assign(Object.create({ language: 'python' }), { state: 'persistent' })
  expect(() => readLimits({ code_runtime: block })).toThrow('E_PRESET_UNSUPPORTED')
})
it('passes exact-limit output through without an artifact copy', () => {
  const text = 'x'.repeat(1024)
  expect(guardOutput(text, 1024)).toEqual({ text, truncated: false })
})
it.each([1024, 2048, 65536, 100000])('bounds the complete preview including its marker at %i', (limit) => {
  const original = 'H'.repeat(100000) + 'T'.repeat(100000)
  const result = guardOutput(original, limit)
  expect(result.truncated).toBe(true)
  expect(result.full).toBe(original)
  expect(result.text.length).toBeLessThanOrEqual(Math.min(limit, 65536))
  const parts = result.text.match(/^(H+)\n\.\.\. \[(\d+) chars elided\] \.\.\.\n(T+)$/)
  if (!parts) throw new Error('missing head, tail or truncation marker')
  expect(Number(parts[2])).toBe(original.length - (parts[1]?.length ?? 0) - (parts[3]?.length ?? 0))
})
it('does not split Unicode surrogate pairs in the preview', () => {
  const result = guardOutput('😀'.repeat(2000), 1024)
  expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  expect(result.text.length).toBeLessThanOrEqual(1024)
})

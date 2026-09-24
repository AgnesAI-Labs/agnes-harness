import { expect, it } from 'vitest'
import { RUN_CODE_FLAVORS, runCodeDescription } from '../src/index.js'

it('describes the Python calling convention and persistent cell semantics', () => {
  const description = runCodeDescription('python')
  expect(description).toContain('persistent kernel')
  expect(description).toContain('await tools.<name>')
  expect(description).toContain('%%bash')
  expect(description).toContain('print summaries')
  expect(description).not.toMatch(/[一-鿿]/)
})

it('keeps TypeScript description separate from Python kernel syntax', () => {
  expect(RUN_CODE_FLAVORS.typescript.language).toBe('typescript')
  expect(runCodeDescription('typescript')).toContain('log summaries')
  expect(runCodeDescription('typescript')).not.toContain('%%bash')
})

it.each(['ruby', '', 'Python', 'constructor', 'toString', '__proto__'])(
  'refuses unsupported lookup %j',
  (language) => {
    expect(() => runCodeDescription(language)).toThrow('no run_code flavor')
  },
)

it('does not expose mutable shared descriptions', () => {
  expect(Reflect.set(RUN_CODE_FLAVORS.python, 'description', 'changed')).toBe(false)
  expect(Reflect.set(RUN_CODE_FLAVORS, 'python', { language: 'python', description: 'changed' })).toBe(false)
  expect(runCodeDescription('python')).toContain('persistent kernel')
})

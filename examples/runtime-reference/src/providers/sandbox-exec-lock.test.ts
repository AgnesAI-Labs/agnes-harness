import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function overlap(left: string, right: string) {
  const lines = (source: string) =>
    new Set(
      source
        .split('\n')
        .map((row) => row.replace(/\s/gu, ''))
        .filter(Boolean),
    )
  const a = lines(left),
    b = lines(right)
  return [...a].filter((row) => b.has(row)).length / Math.min(a.size, b.size)
}
describe('independent sandbox and execution recipes', () => {
  it.each(['sandbox', 'exec'])('%s rejects copied implementations and Host imports', (name) => {
    const reference = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')
    const production = readFileSync(
      new URL(`../../../../packages/host/src/runtime/providers/${name}.ts`, import.meta.url),
      'utf8',
    )
    expect(reference).not.toMatch(/(?:from|import\s*\()[^\n]*(?:packages\/host|runtime\/platform)/u)
    expect(overlap(reference, production)).toBeLessThanOrEqual(0.5)
    expect(overlap(production, production)).toBeGreaterThan(0.5)
  })
  it('uses different native ownership algorithms', () => {
    const a = readFileSync(new URL('../../native/execution-owner.c', import.meta.url), 'utf8')
    const b = readFileSync(
      new URL('../../../../packages/host/native/exec-governor.c', import.meta.url),
      'utf8',
    )
    expect(overlap(a, b)).toBeLessThanOrEqual(0.5)
    expect(a).toContain('PROC_UID_ONLY')
    expect(b).toContain('proc_listallpids')
  })
})

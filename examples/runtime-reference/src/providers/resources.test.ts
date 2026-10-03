import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps the resource reference independent of the default provider', () => {
  const reference = readFileSync(new URL('./resources.ts', import.meta.url), 'utf8')
  const original = readFileSync(
    new URL('../../../../packages/host/src/runtime/providers/resources.ts', import.meta.url),
    'utf8',
  )
  expect(reference).not.toMatch(/from\s+['"][^'"]*(?:packages\/host|providers\/resources|resource-retention)/)
  const lines = (source: string) =>
    new Set(
      source
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  const a = lines(reference),
    b = lines(original)
  const common = [...a].filter((line) => b.has(line)).length
  expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
})

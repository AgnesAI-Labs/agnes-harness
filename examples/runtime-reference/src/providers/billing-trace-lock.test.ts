import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const lines = (source: string) =>
  new Set(
    source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
it.each(['trace', 'billing'] as const)('%s remains an independent implementation', (service) => {
  const reference = readFileSync(fileURLToPath(new URL(`./${service}.ts`, import.meta.url)), 'utf8')
  const primary = readFileSync(
    fileURLToPath(new URL(`../../../../packages/host/src/runtime/providers/${service}.ts`, import.meta.url)),
    'utf8',
  )
  const a = lines(reference),
    b = lines(primary),
    shared = [...a].filter((line) => b.has(line)).length
  expect(shared / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  expect(reference).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*(?:packages\/host|@agnes\/host)/)
  const support = readFileSync(fileURLToPath(new URL('./billing-trace-runtime.ts', import.meta.url)), 'utf8')
  expect(support).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*(?:packages\/host|@agnes\/host)/)
})

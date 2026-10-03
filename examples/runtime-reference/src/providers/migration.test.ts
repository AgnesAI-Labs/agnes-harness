import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const normalized = (text: string) =>
  new Set(
    text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ''))
      .filter(Boolean),
  )
describe('independent reference migration', () => {
  it('has no import from the default implementation and shares at most half its normalized lines', () => {
    const reference = ['migration.ts', 'migration-evidence.ts']
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    expect(reference).not.toMatch(/@agnes\/host|packages\/host|runtime\/migration\//u)
    const defaultSource = [
      'providers/migration.ts',
      'migration/controller.ts',
      'migration/eligibility.ts',
      'migration/receipt-verification.ts',
      'migration/primitives.ts',
    ]
      .map((file) =>
        readFileSync(new URL(`../../../../packages/host/src/runtime/${file}`, import.meta.url), 'utf8'),
      )
      .join('\n')
    const left = normalized(reference),
      right = normalized(defaultSource)
    expect(
      [...left].filter((line) => right.has(line)).length / Math.min(left.size, right.size),
    ).toBeLessThanOrEqual(0.5)
  })
})

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLocalExamplesCatalog } from '../src/local-examples-catalog.js'

const workspace = fileURLToPath(new URL('../../..', import.meta.url))
const dshFamilies = [
  'dsh-input-controls',
  'dsh-model-picker-a',
  'dsh-model-picker-b',
  'dsh-tool-view',
] as const

describe('DSH local example catalog', () => {
  it('publishes v1 and v2 for every DSH family, but no broken candidate by default', async () => {
    const catalog = await createLocalExamplesCatalog({ workspace, now: () => 0 })
    const entries = (await catalog.read({ offline: true })).entries.filter((entry) =>
      dshFamilies.some((family) => entry.id === `@agnes-examples/${family}`),
    )

    expect(entries).toHaveLength(dshFamilies.length * 2)
    expect(entries.map((entry) => `${entry.id}@${entry.version}`).sort()).toEqual(
      dshFamilies
        .flatMap((family) => [`@agnes-examples/${family}@1.0.0`, `@agnes-examples/${family}@2.0.0`])
        .sort(),
    )
    expect(entries.every((entry) => entry.version !== '3.0.0')).toBe(true)
  })

  it('exposes exactly one broken candidate per DSH family only in test mode', async () => {
    const normal = await createLocalExamplesCatalog({ workspace, now: () => 0 })
    const withBroken = await createLocalExamplesCatalog({
      workspace,
      includeTestOnlyBroken: true,
      now: () => 0,
    })
    const normalEntries = (await normal.read({ offline: true })).entries
    const brokenEntries = (await withBroken.read({ offline: true })).entries.filter((entry) =>
      dshFamilies.some((family) => entry.id === `@agnes-examples/${family}` && entry.version === '3.0.0'),
    )

    expect(normalEntries.some((entry) => entry.version === '3.0.0')).toBe(false)
    expect(brokenEntries).toHaveLength(dshFamilies.length)
    expect(new Set(brokenEntries.map((entry) => entry.id))).toEqual(
      new Set(dshFamilies.map((family) => `@agnes-examples/${family}`)),
    )
  })
})

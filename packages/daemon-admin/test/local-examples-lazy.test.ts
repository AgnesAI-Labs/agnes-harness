import { expect, it, vi } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

const fixture = vi.hoisted(() => ({ version: '1.0.0' }))
vi.mock('@agnes/package-manager', async (original) => {
  const module = await original<typeof import('@agnes/package-manager')>()
  return {
    ...module,
    DEFAULT_ENABLED_BUNDLED_PACKAGES: [],
    OPTIONAL_BUNDLED_PACKAGES: [],
    bundledExamplesEntries: async () => [
      {
        id: '@fixture/lazy',
        version: fixture.version,
        source: { type: 'file', ref: 'file:./bundled-examples/lazy' },
        integrity: `sha256-${'a'.repeat(64)}`,
        license: 'MIT',
        contributions: [],
        compatibility: 'supported',
      },
    ],
  }
})

it('loads verified metadata on first demand, serializes reads, and recovers after cancellation', async () => {
  // No local examples directory: isolate discovery lifecycle from real payload build/inspection.
  const catalog = await discoverLocalExamples(import.meta.dirname)
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(catalog.read({ offline: true, signal: cancelled.signal })).rejects.toThrow()
  fixture.version = '1.1.0'
  const [first, cached] = await Promise.all([
    catalog.read({ offline: true }),
    catalog.read({ offline: true }),
  ])
  expect(first.entries).toMatchObject([{ id: '@fixture/lazy', version: '1.1.0' }])
  expect(first.sources.every((source) => source.status === 'fresh')).toBe(true)
  expect(cached.entries).toEqual(first.entries)
  expect(cached.sources.every((source) => source.status === 'cached')).toBe(true)
  fixture.version = '1.2.0'
  expect((await catalog.read({ offline: true })).entries).toEqual(first.entries)
  expect((await catalog.read()).entries).toMatchObject([{ version: '1.2.0' }])
})

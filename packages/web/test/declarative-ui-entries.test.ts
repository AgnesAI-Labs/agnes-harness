import type { PluginUiEntry } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { matchesUiConfiguration } from '../src/declarative-ui/configuration.js'
import { createPluginUiEntries } from '../src/declarative-ui/entries.js'

const entry = (packageId: string, id = 'same'): PluginUiEntry => ({
  packageId,
  rowId: packageId,
  integrity: `sha256-${'a'.repeat(64)}`,
  placement: 'sidebar',
  id,
  title: { en: packageId },
  configure: true,
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('drops reads that predate a package notice, a profile change, or a reconnect', async () => {
  const ui = createPluginUiEntries()
  ui.setScope(true, 'local')
  for (const invalidate of [
    () => ui.packageChanged(undefined),
    () => ui.setScope(true, 'other'),
    () => {
      ui.setScope(false, 'other')
      ui.setScope(true, 'other')
    },
  ]) {
    const { promise, resolve } = deferred<unknown>()
    const request = ui.refresh(() => promise)
    invalidate()
    resolve({ entries: [entry('obsolete')] })
    await request
    expect(ui.getSnapshot().entries).toEqual([])
  }
  await ui.refresh(async (profile) => ({ entries: [entry(profile)] }))
  expect(ui.getSnapshot().entries.map(({ packageId }) => packageId)).toEqual(['other'])
  await ui.refresh(async () => {
    throw new Error('method not found')
  })
  expect(ui.getSnapshot().entries).toEqual([])
})

it('does not replace a newer observation with a slower read on the same connection', async () => {
  const ui = createPluginUiEntries()
  ui.setScope(true, 'local')
  const earlier = deferred<unknown>()
  const oldRead = ui.refresh(() => earlier.promise)
  await ui.refresh(async () => ({ entries: [entry('newer')] }))
  earlier.resolve({ entries: [entry('older')] })
  await oldRead
  expect(ui.getSnapshot().entries.map(({ packageId }) => packageId)).toEqual(['newer'])
})

it('keeps repeated declarations independent and retires a bound action without substituting a replacement', async () => {
  const ui = createPluginUiEntries()
  ui.setScope(true, 'local')
  await ui.refresh(async () => ({ entries: [entry('first'), entry('other')] }))
  const [first, other] = ui.getSnapshot().entries
  expect(first?.testId).toBe('declarative-ui-sidebar-same')
  expect(other?.testId).not.toBe(first?.testId)
  if (!first || !other) throw new Error('Expected two entries')
  ui.open('sidebar', first)
  expect(ui.getSnapshot().sidebar?.entry).toBe(first)
  const lease = ui.configuration(first)
  expect(lease?.target).toEqual({
    profile: 'local',
    packageId: 'first',
    rowId: 'first',
    integrity: first.integrity,
  })
  ui.packageChanged('other')
  expect(lease?.isCurrent()).toBe(true)
  expect(ui.getSnapshot().entries).toEqual([first])
  ui.packageChanged(undefined)
  expect(ui.getSnapshot().sidebar?.entry).toBe(first)
  expect(lease?.isCurrent()).toBe(true)
  await ui.refresh(async () => ({ entries: [] }))
  expect(ui.getSnapshot().sidebar).toBeUndefined()
  expect(lease?.isCurrent()).toBe(false)
  await ui.refresh(async () => ({ entries: [entry('first')] }))
  const restored = ui.getSnapshot().entries[0]
  if (!restored) throw new Error('Expected restored entry')
  ui.open('sidebar', restored)
  const restoredLease = ui.configuration(restored)
  ui.packageChanged('first')
  expect(ui.getSnapshot().sidebar).toBeUndefined()
  expect(restoredLease?.isCurrent()).toBe(false)
  await ui.refresh(async () => ({ entries: [{ ...entry('first'), integrity: `sha256-${'b'.repeat(64)}` }] }))
  expect(ui.getSnapshot().sidebar).toBeUndefined()
  expect(restoredLease?.isCurrent()).toBe(false)
})

it('requires the same enabled, trusted package version in the active admin profile', () => {
  const { packageId, rowId, integrity } = entry('first')
  const target = { profile: 'local', packageId, rowId, integrity }
  const installed = { id: packageId, integrity, desired: 'enabled' as const, trusted: true, blockers: [] }
  expect(matchesUiConfiguration(target, 'local', installed)).toBe(true)
  expect(matchesUiConfiguration(target, 'other', installed)).toBe(false)
  expect(matchesUiConfiguration(target, 'local', { ...installed, id: 'other' })).toBe(false)
  expect(
    matchesUiConfiguration(target, 'local', { ...installed, integrity: `sha256-${'b'.repeat(64)}` }),
  ).toBe(false)
  expect(matchesUiConfiguration(target, 'local', { ...installed, desired: 'installed-disabled' })).toBe(false)
  expect(matchesUiConfiguration(target, 'local', { ...installed, trusted: false })).toBe(false)
  expect(matchesUiConfiguration(target, 'local', undefined)).toBe(false)
})

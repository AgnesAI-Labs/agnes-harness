import { readFileSync } from 'node:fs'
import type { ClientContext } from '@agnes/web-client'
import { conversationCards, homeEntries, workbenchPanels } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client.js'

vi.mock('@agnes/web-ui', () =>
  Object.fromEntries(
    ['Button', 'Segmented', 'SettingsCard', 'SettingsPage', 'SettingsRow', 'SettingsState'].map((name) => [
      name,
      () => null,
    ]),
  ),
)

it('registers optional bilingual entries and releases all contributions on disable/uninstall', () => {
  const releaseLocale = vi.fn()
  const query = vi.fn()
  const ctx = {
    locale: { register: vi.fn(() => releaseLocale) },
    homeEntries,
    session: { projection: { read: query } },
  } as unknown as ClientContext
  const stop = apply(ctx)
  try {
    expect(homeEntries.get('usage-cockpit')?.placement).toBe('primary')
    expect(workbenchPanels.get('usage-cockpit')?.edge).toBe('right')
    expect(
      conversationCards.get('usage-cockpit')?.matches({ kind: 'conversation.turn-tail', data: {} }),
    ).toBe(true)
    expect(query).not.toHaveBeenCalled()
  } finally {
    stop()
  }
  expect(homeEntries.get('usage-cockpit')).toBeUndefined()
  expect(workbenchPanels.get('usage-cockpit')).toBeUndefined()
  expect(conversationCards.get('usage-cockpit')).toBeUndefined()
  expect(releaseLocale).toHaveBeenCalledOnce()
  const next = apply(ctx)
  next()
})

it('ships in the catalogue with no tools and stays out of default activation', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.agnes.plugins[0].capabilities).toEqual({ ui: true })
  const descriptor = JSON.parse(readFileSync(new URL('../src/agnes.client.json', import.meta.url), 'utf8'))
  expect(descriptor.client.homeEntries).toHaveLength(1)
  expect(descriptor.client.services).toBeUndefined()
})

it('unwinds partial registration failure without removing another contribution', () => {
  const blocking = workbenchPanels.register({
    id: 'usage-cockpit',
    order: 0,
    edge: 'right',
    titleKey: 'test',
    component: () => null,
  })
  const releaseLocale = vi.fn()
  const ctx = { locale: { register: () => releaseLocale }, homeEntries } as unknown as ClientContext
  try {
    expect(() => apply(ctx)).toThrow('already registered')
    expect(homeEntries.get('usage-cockpit')).toBeUndefined()
    expect(workbenchPanels.get('usage-cockpit')?.titleKey).toBe('test')
    expect(releaseLocale).toHaveBeenCalledOnce()
  } finally {
    blocking()
  }
})

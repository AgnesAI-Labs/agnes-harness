import { expect, it, vi } from 'vitest'
import { RegistrableLink } from '../src/fact-chain-links.js'
import { type HomeEntry, HomeNavigation, UiExtensionRegistry } from '../src/ui-registries.js'

it('orders registrations, refuses duplicate IDs and disposes only its own live entry', () => {
  const registry = new UiExtensionRegistry<{ id: string; order: number }>()
  const changed = vi.fn()
  const unsubscribe = registry.subscribe(changed)
  const first = registry.register({ id: 'later', order: 20 })
  const remove = registry.register({ id: 'earlier', order: 10 })
  expect(registry.entries().map((entry) => entry.id)).toEqual(['earlier', 'later'])
  expect(() => registry.register({ id: 'later', order: 0 })).toThrow('already registered')
  remove()
  expect(registry.get('earlier')).toBeUndefined()
  first()
  registry.register({ id: 'later', order: 1 })
  first()
  expect(registry.get('later')?.order).toBe(1)
  unsubscribe()
  const version = registry.getSnapshot()
  const notifications = changed.mock.calls.length
  registry.register({ id: 'last', order: 30 })
  expect(registry.getSnapshot()).toBeGreaterThan(version)
  expect(changed).toHaveBeenCalledTimes(notifications)
})

it('keeps presentation links unavailable without a host and disposes only the registered opener', () => {
  const links = new RegistrableLink<string>()
  expect(links.open('facts')).toBe(false)
  const removeFirst = links.register((target) => target === 'facts')
  expect(links.open('facts')).toBe(true)
  const removeSecond = links.register((target) => target === 'files')
  removeFirst()
  expect(links.open('files')).toBe(true)
  expect(links.open('facts')).toBe(false)
  removeSecond()
  expect(links.open('files')).toBe(false)
})

it('notifies every subscriber even when an earlier one throws', () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const registry = new UiExtensionRegistry<{ id: string; order: number }>()
  const later = vi.fn()
  registry.subscribe(() => {
    throw new Error('view failed')
  })
  registry.subscribe(later)
  registry.register({ id: 'one', order: 1 })
  expect(later).toHaveBeenCalledOnce()
  report.mockRestore()
})

it('lists home entries by order and drops an entry when its registration is disposed', () => {
  const entries = new UiExtensionRegistry<HomeEntry>()
  const entry = (id: string, order: number): HomeEntry => ({
    id,
    order,
    icon: 'plug',
    titleKey: `${id}.title`,
    component: () => null,
  })
  entries.register(entry('automation', 30))
  entries.register(entry('agents', 10))
  const removePlugin = entries.register(entry('example.board', 100))
  entries.register(entry('plugins', 20))
  expect(entries.entries().map((item) => item.id)).toEqual([
    'agents',
    'plugins',
    'automation',
    'example.board',
  ])
  removePlugin()
  expect(entries.get('example.board')).toBeUndefined()
  // A reload registers the same ID again; the earlier disposer no longer owns it.
  entries.register(entry('example.board', 5))
  removePlugin()
  expect(entries.entries()[0]?.id).toBe('example.board')
})

it('tracks the requested home page and notifies on open and close', () => {
  const navigation = new HomeNavigation()
  const changed = vi.fn()
  navigation.subscribe(changed)
  expect(navigation.getSnapshot()).toBeUndefined()
  navigation.open('plugins', { tab: 'mcp' })
  expect(navigation.getSnapshot()).toEqual({ id: 'plugins', selection: { tab: 'mcp' } })
  navigation.open('agents')
  expect(navigation.getSnapshot()).toEqual({ id: 'agents' })
  navigation.close()
  navigation.close()
  expect(navigation.getSnapshot()).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(3)
})

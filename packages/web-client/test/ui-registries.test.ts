import { expect, it, vi } from 'vitest'
import { RegistrableLink } from '../src/fact-chain-links.js'
import { UiExtensionRegistry } from '../src/ui-registries.js'

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

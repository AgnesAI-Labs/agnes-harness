import { expect, it, vi } from 'vitest'
import { RegistrableLink } from '../src/fact-chain-links.js'
import {
  type HomeEntry,
  HomeEntryRegistry,
  HomeNavigation,
  homeEntryGroups,
  UiExtensionRegistry,
} from '../src/ui-registries.js'

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

it('hands the selection an opener asked for to the registered destination', () => {
  const links = new RegistrableLink<string>()
  const opener = vi.fn(
    (target: string, selection?: unknown) => target === 'terminal' && selection !== undefined,
  )
  const remove = links.register(opener)
  expect(links.open('terminal', { childId: 'c1' })).toBe(true)
  expect(opener).toHaveBeenCalledWith('terminal', { childId: 'c1' })
  // A link that carries no selection reaches the opener without one.
  expect(links.open('terminal')).toBe(false)
  remove()
  expect(links.open('terminal', { childId: 'c1' })).toBe(false)
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

it('keeps every primary entry inline and enforces limits without replacing registrations', () => {
  const entries = new HomeEntryRegistry()
  const entry = (id: string, placement: 'primary' | 'secondary', order = 1): HomeEntry => ({
    id,
    placement,
    order,
    icon: 'plug',
    titleKey: id,
    component: () => null,
  })
  for (const id of ['delta', 'alpha', 'gamma', 'beta']) entries.register(entry(id, 'primary'))
  for (let i = 0; i < 5; i++) entries.register(entry(`extra-${i}`, 'secondary'))
  expect(homeEntryGroups(entries.entries()).inline.map((row) => row.id)).toEqual([
    'alpha',
    'beta',
    'delta',
    'gamma',
  ])
  expect(homeEntryGroups(entries.entries()).more).toHaveLength(5)
  expect(() => entries.register(entry('alpha', 'secondary', 0))).toThrow('already registered')
  expect(entries.get('alpha')?.placement).toBe('primary')
  const disposers = []
  for (let i = 0; i < 28; i++) disposers.push(entries.register(entry(`primary-${i}`, 'primary')))
  expect(() => entries.register(entry('overflow', 'primary'))).toThrow('limit')
  disposers[0]?.()
  entries.register(entry('overflow', 'primary'))
  expect(() => entries.register({ ...entry('invalid', 'primary'), placement: 'invalid' as never })).toThrow(
    'placement',
  )
})

it('binds global entries to a declared active profile owner and revokes before fiber cleanup', async () => {
  const { scopedHomeEntries, revokeContributionOwner, contributionAvailability } = await import(
    '../src/contribution-scope.js'
  )
  const { homeEntries } = await import('../src/ui-registries.js')
  const module = {
    packageId: 'acme/parent',
    revision: 'v1',
    rowId: 'web:acme/parent',
    binding: {
      lifetime: 'profile' as const,
      owner: 'web:acme/parent',
      packageId: 'acme/parent',
      integrity: 'v1',
      profileId: 'test',
      activationId: 'one',
      availability: 'active' as const,
    },
    homeEntries: [{ id: 'owned', placement: 'primary' as const }],
  }
  const off: (() => void)[] = []
  const entries = scopedHomeEntries(module, (dispose) => off.push(dispose))
  const entry: HomeEntry = {
    id: 'owned',
    placement: 'primary',
    order: 40,
    icon: 'plug',
    titleKey: 'Owned',
    component: () => null,
  }
  const availability = contributionAvailability(module, (dispose) => off.push(dispose))
  let observed = ''
  availability.subscribe(() => {
    observed = availability.getSnapshot()?.availability ?? ''
  })
  const { reserveHomeEntry } = await import('../src/declared-home-entries.js')
  const release = reserveHomeEntry(module.rowId, { ...entry, component: () => null })
  expect(() =>
    scopedHomeEntries({ ...module, binding: { ...module.binding, owner: 'web:other' } }, () => {}).register(
      entry,
    ),
  ).toThrow('already registered')
  entries.register(entry)
  release() // The old placeholder's disposer must not revoke the live registration.
  expect(homeEntries.get('owned')).toBeDefined()
  expect(() => entries.register({ ...entry, id: 'undeclared' })).toThrow('Undeclared')
  expect(() =>
    scopedHomeEntries({ ...module, binding: { ...module.binding, lifetime: 'session' } }, () => {}).register(
      entry,
    ),
  ).toThrow('profile')
  revokeContributionOwner(module.rowId)
  expect(homeEntries.get('owned')).toBeUndefined()
  expect(observed).toBe('disabled')
  expect(() => entries.register(entry)).toThrow('profile')
  for (const dispose of off) dispose()
})

it('renders only the host own declared example page and removes it on scope revocation', async () => {
  const { scopedExamplePages } = await import('../src/example-pages.js')
  const { revokeContributionOwner } = await import('../src/contribution-scope.js')
  const identity = (packageId: string) => ({
    packageId,
    revision: 'v1',
    rowId: `web:${packageId}`,
    binding: {
      lifetime: 'profile' as const,
      owner: `web:${packageId}`,
      packageId,
      integrity: 'v1',
      profileId: 'test',
      activationId: 'one',
      availability: 'active' as const,
    },
  })
  const parent = identity('acme/parent')
  const child = {
    ...identity('acme/example'),
    exampleOf: parent.packageId,
    pageEntry: 'scene',
    examplePages: ['scene'],
  }
  const cleanup: (() => void)[] = []
  const effect = (off: () => void) => cleanup.push(off)
  const pages = scopedExamplePages(child, effect)
  const host = scopedExamplePages(parent, effect)
  const other = scopedExamplePages(identity('acme/other'), effect)
  const context = { t: (key: string) => key }
  pages.register({ id: 'scene', component: () => null })
  expect(host.render(child.packageId, context)).not.toBeNull()
  expect(other.render(child.packageId, context)).toBeNull()
  expect(() => pages.register({ id: 'undeclared', component: () => null })).toThrow('Undeclared')
  revokeContributionOwner(child.rowId)
  expect(host.render(child.packageId, context)).toBeNull()
  expect(() => pages.register({ id: 'scene', component: () => null })).toThrow('Undeclared')
  for (const off of cleanup) off()
})

// @vitest-environment happy-dom
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('mounts a profile entry without requests, releases registrations on uninstall and rolls back failed registration', async () => {
  const clientPackage = '@agnes/web-client'
  const { homeEntries } = await import(clientPackage)
  const { apply } = await import(
    pathToFileURL(
      join(process.cwd(), 'packages/package-manager/bundled-plugins/business-recipes/src/client.js'),
    ).href
  )
  let catalogs = 0
  let reads = 0
  const watchers = new Set<() => void>()
  const ctx = {
    homeEntries,
    profile: {
      examples: {
        list: async () => {
          reads++
          return []
        },
      },
    },
    availability: {
      getSnapshot: () => ({ availability: 'active' }),
      subscribe: (listener: () => void) => {
        watchers.add(listener)
        return () => watchers.delete(listener)
      },
    },
    locale: {
      register: () => {
        catalogs++
        return () => {
          catalogs--
        }
      },
    },
  }
  const dispose = apply(ctx)
  try {
    expect(homeEntries.get('business-recipes')).toBeDefined()
    expect(reads).toBe(0)
    expect(catalogs).toBe(1)
  } finally {
    dispose()
    dispose()
  }
  expect(homeEntries.get('business-recipes')).toBeUndefined()
  expect(catalogs).toBe(0)
  expect(watchers.size).toBe(0)
  expect(() =>
    apply({
      ...ctx,
      homeEntries: {
        register() {
          throw new Error('registration refused')
        },
      },
    }),
  ).toThrow('registration refused')
  expect(catalogs).toBe(0)
  expect(watchers.size).toBe(0)
})

import { expect, it } from 'vitest'
import { revokeContributionOwner } from '../src/contribution-scope.js'
import { PresentationRoleRegistry, scopedPresentationRoles } from '../src/presentation-roles.js'

it('elects exactly one complete presentation, rejects equal priorities and restores the default', () => {
  const roles = new PresentationRoleRegistry()
  const visible = new Set<string>()
  const provider = (id: string, priority: number) => ({
    role: 'deliverables',
    priority,
    mount() {
      expect(visible.size).toBe(0)
      visible.add(`${id}-cards`)
      visible.add(`${id}-tab`)
      return () => {
        visible.clear()
      }
    },
  })
  const official = roles.register('official', provider('official', 100))
  const gallery = roles.register('gallery', provider('gallery', 0))
  expect([...visible]).toEqual(['gallery-cards', 'gallery-tab'])
  expect(() => roles.register('conflict', provider('conflict', 0))).toThrow('already has an entry')
  expect(() =>
    roles.register('broken', {
      role: 'deliverables',
      priority: -1,
      mount() {
        throw new Error('bad plugin')
      },
    }),
  ).toThrow('bad plugin')
  expect([...visible]).toEqual(['gallery-cards', 'gallery-tab'])
  gallery()
  gallery()
  expect([...visible]).toEqual(['official-cards', 'official-tab'])
  official()
  expect(visible.size).toBe(0)
})

it('revokes a profile role before asynchronous module disposal and prevents late re-registration', () => {
  const effects: (() => void)[] = []
  const roles = scopedPresentationRoles(
    {
      packageId: 'community',
      revision: 'v1',
      binding: {
        owner: 'community-row',
        lifetime: 'profile',
        availability: 'active',
      },
    } as never,
    (off) => effects.push(off),
  )
  let mounted = false
  roles.register({
    role: 'test-presentation',
    mount() {
      mounted = true
      return () => {
        mounted = false
      }
    },
  })
  expect(mounted).toBe(true)
  revokeContributionOwner('community-row')
  expect(mounted).toBe(false)
  expect(() => roles.register({ role: 'test-presentation', mount: () => () => {} })).toThrow('active profile')
  for (const off of effects) off()
})

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

it('filters standard product roles before priority so installing B cannot steal A, and explicit user choice wins', () => {
  const roles = new PresentationRoleRegistry()
  const visible = new Set<string>()
  const consent = (packageId: string) => ({
    packageId,
    clientId: 'ui',
    integrity: 'one',
    bindingDigest: 'a'.repeat(64),
  })
  const module = (packageId: string) => ({
    packageId,
    clientId: 'ui',
    revision: 'one',
    binding: {
      packageId,
      integrity: 'one',
      lifetime: 'profile' as const,
      availability: 'active' as const,
      owner: packageId,
      profileId: 'test',
      activationId: 'one',
    },
    presentationRoleBindings: { navigation: 'a'.repeat(64) },
  })
  const provider = (id: string, priority: number) => ({
    role: 'navigation',
    priority,
    mount() {
      visible.add(id)
      return () => {
        visible.delete(id)
      }
    },
  })
  roles.select({ navigation: { packageId: 'a', clientId: 'ui' } })
  const a = roles.register('a-owner', provider('a', 10), module('a'))
  const b = roles.register('b-owner', provider('b', -100), module('b'))
  expect([...visible]).toEqual(['a'])
  roles.select({ navigation: { packageId: 'a', clientId: 'ui' } }, { navigation: consent('b') })
  expect([...visible]).toEqual(['b'])
  const broken = roles.register(
    'broken-owner',
    {
      ...provider('broken', -200),
      mount() {
        throw new Error('broken')
      },
    },
    module('broken'),
  )
  roles.select({ navigation: { packageId: 'a', clientId: 'ui' } }, { navigation: consent('broken') })
  expect([...visible]).toEqual(['a'])
  expect(roles.resolution('navigation')).toEqual({
    effective: { packageId: 'a', clientId: 'ui' },
    reason: 'mount-failed',
  })
  broken()
  roles.select({ navigation: { packageId: 'a', clientId: 'ui' } }, {})
  expect([...visible]).toEqual(['a'])
  roles.select()
  expect([...visible]).toEqual([])
  a()
  b()
})

it('reports conflict sources and restores the release default after an application selects a bad mount', () => {
  const roles = new PresentationRoleRegistry()
  let visible = ''
  roles.register(
    'release-default',
    {
      role: 'conversation',
      priority: 100,
      mount() {
        visible = 'default'
        return () => {
          visible = ''
        }
      },
    },
    { packageId: '@agnes/conversation-ui', clientId: 'ui', revision: 'one' },
  )
  roles.register(
    'broken-source',
    {
      role: 'conversation',
      priority: 0,
      mount() {
        throw new Error('file:///private/token=secret/bad mount')
      },
    },
    { packageId: 'custom', clientId: 'ui', revision: 'one' },
  )
  roles.select({ conversation: { packageId: 'custom', clientId: 'ui' } })
  expect(visible).toBe('default')
  expect(roles.getSnapshot()).toContainEqual({
    role: 'conversation',
    owners: ['broken-source'],
    reason: 'mount-failed',
    failure: {
      code: 'PRESENTATION_MOUNT_FAILED',
      packageId: 'custom',
      phase: 'mount',
      summary: 'The presentation failed. Saved results may still exist.',
    },
  })
  expect(JSON.stringify(roles.getSnapshot())).not.toMatch(/secret|private|file:/)
  const provider = { role: 'custom-role', mount: () => () => {} }
  roles.register('source-a', provider)
  expect(() => roles.register('source-b', provider)).toThrow('source-a, source-b')
  expect(roles.getSnapshot()).toContainEqual({
    role: 'custom-role',
    owners: ['source-a', 'source-b'],
    reason: 'conflict',
  })
})

it.each(['integrity', 'binding', 'missing', 'inactive'] as const)(
  'refuses a name-matched role with %s consent drift and diagnoses it before mount',
  (drift) => {
    const roles = new PresentationRoleRegistry(),
      mounted: string[] = []
    const target = { packageId: 'community', clientId: 'ui', integrity: 'one', bindingDigest: 'a'.repeat(64) }
    roles.select({ deliverables: target }, { deliverables: target })
    const stop = roles.register(
      'candidate',
      {
        role: 'deliverables',
        mount() {
          mounted.push('upgraded')
          return () => {}
        },
      },
      {
        packageId: 'community',
        clientId: 'ui',
        revision: drift === 'integrity' ? 'two' : 'one',
        binding: {
          packageId: 'community',
          integrity: drift === 'integrity' ? 'two' : 'one',
          owner: 'candidate',
          profileId: 'test',
          activationId: 'one',
          lifetime: 'profile',
          availability: drift === 'inactive' ? 'disabled' : 'active',
        },
        ...(drift === 'missing'
          ? {}
          : {
              presentationRoleBindings: {
                deliverables: drift === 'binding' ? 'b'.repeat(64) : target.bindingDigest,
              },
            }),
      },
    )
    expect(mounted).toEqual([])
    expect(roles.resolution('deliverables')).toEqual({ effective: null, reason: 'consent-mismatch' })
    stop()
  },
)

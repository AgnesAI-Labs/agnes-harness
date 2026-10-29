import { Context } from '@agnes/cordis'
import { defineKind } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { installProviderRegistry } from '../../src/assemble/provider-registry.js'

type Thing = { id: string; version: string; create(): object }
const thing: Thing = { id: 'only', version: '1.0.0', create: () => ({}) }

it('defaults a kind to open, optional and unpinned, and records the declared attributes', () => {
  const plain = defineKind<Thing>({ kind: 'plain', validate: () => undefined })
  expect([plain.required, plain.authority, plain.pinned]).toEqual([false, 'open', false])
  const seam = defineKind<Thing>({
    kind: 'strict',
    required: true,
    pinned: true,
    validate: () => undefined,
  })
  expect([seam.required, seam.authority, seam.pinned]).toEqual([true, 'open', true])
  expect(() =>
    defineKind<Thing>({ kind: 'bad', authority: 'nobody' as never, validate: () => undefined }),
  ).toThrow()
})

it('refuses a package registration for a host-authority kind and shows it read-only in the catalog', async () => {
  const root = new Context()
  const hostKind = defineKind<Thing>({
    kind: 'host-only',
    authority: 'host',
    validate: () => undefined,
  })
  const registry = installProviderRegistry(root, hostKind)
  expect(() => root.providers.registerHost(hostKind, '@acme/pkg', thing)).toThrow(/host-owned/)
  registry.register('@agnes/host', thing)
  expect(root.providers.catalog()).toEqual([
    expect.objectContaining({ kind: 'host-only', id: 'only', authority: 'host', required: false }),
  ])
  await root.fiber.dispose()
})

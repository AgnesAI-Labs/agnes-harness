import { PackageError } from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { createPackageReferences, type PackageReferenceFacts } from '../src/packages/index.js'

const facts: PackageReferenceFacts = {
  dependencies: ['acme/dependent'],
  profile: ['seam:ledger'],
  deployments: ['customer:surface.json'],
  runtime: [
    { kind: 'drainable', reference: 'session:active-call' },
    { kind: 'candidate', reference: 'candidate:next' },
    { kind: 'pin', reference: 'pin:active' },
    { kind: 'unknown-contribution', reference: 'contribution:legacy' },
  ],
}

it('uses one frozen fact read and lets activation drain ordinary hot-replacement calls', async () => {
  const read = vi.fn(async () => facts)
  const references = createPackageReferences(read)
  expect(await references('local-dev', 'acme/pkg-a', 'update', ['acme/pkg-a'])).toEqual([
    { code: 'dependency', references: ['acme/dependent'] },
    { code: 'profile', references: ['seam:ledger'] },
    { code: 'deployment', references: ['customer:surface.json'] },
    { code: 'generation', references: ['candidate:next', 'pin:active'] },
    { code: 'unknown-contribution', references: ['contribution:legacy'] },
  ])
  expect(read).toHaveBeenCalledWith({
    profile: 'local-dev',
    packageId: 'acme/pkg-a',
    operation: 'update',
    extensions: ['acme/pkg-a'],
  })
})

it('requires drainable calls to be gone before remove and preserves real blockers', async () => {
  const references = createPackageReferences(async () => facts)
  expect(await references('local-dev', 'acme/pkg-a', 'remove')).toEqual([
    { code: 'dependency', references: ['acme/dependent'] },
    { code: 'profile', references: ['seam:ledger'] },
    { code: 'deployment', references: ['customer:surface.json'] },
    {
      code: 'generation',
      references: ['candidate:next', 'pin:active', 'session:active-call'],
    },
    { code: 'unknown-contribution', references: ['contribution:legacy'] },
  ])
})

it('fails closed on malformed or oversized authority facts', async () => {
  const malformed = createPackageReferences(async () => ({
    dependencies: [],
    profile: [],
    deployments: [],
    runtime: [{ kind: 'drainable', reference: '' }],
  }))
  await expect(malformed('local-dev', 'acme/pkg-a', 'update')).rejects.toBeInstanceOf(PackageError)

  const oversized = createPackageReferences(async () => ({
    dependencies: Array.from({ length: 129 }, (_, index) => `dependency:${index}`),
    profile: [],
    deployments: [],
    runtime: [],
  }))
  await expect(oversized('local-dev', 'acme/pkg-a', 'update')).rejects.toBeInstanceOf(PackageError)
})

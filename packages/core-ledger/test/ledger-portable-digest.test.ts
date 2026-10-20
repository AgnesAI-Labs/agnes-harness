// Re-runs the ledger suites with the portable digest, as a non-Node host would compute it.
import { expect, it, vi } from 'vitest'

// `#sha256` resolves to this file under Node, so replacing it here is what makes the hash module portable.
vi.mock(
  '@agnes/core-common/request/sha256-node',
  async () => await import('@agnes/core-common/request/sha256-portable'),
)

it('runs the ledger suites on the portable digest', async () => {
  const hash = await import('@agnes/core-common/request/hash')
  const portable = await import('@agnes/core-common/request/sha256-portable')
  expect(hash.SHA256_IMPLEMENTATION).toBe('portable')
  expect(hash.createSha256).toBe(portable.createSha256)
  expect(hash.sha256Hex).toBe(portable.sha256Hex)
})

await import('./ledger-integrity.test.js')
await import('./open-replay.test.js')
await import('./ledger-golden-digest.test.js')

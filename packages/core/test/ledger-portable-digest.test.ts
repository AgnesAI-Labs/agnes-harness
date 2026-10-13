// Re-runs the ledger suites with the portable digest, as a non-Node host would compute it.
import { expect, it, vi } from 'vitest'

vi.mock('#sha256', async () => await import('../src/request/sha256-portable.js'))

it('runs the ledger suites on the portable digest', async () => {
  const hash = await import('../src/request/hash.js')
  const portable = await import('../src/request/sha256-portable.js')
  expect(hash.SHA256_IMPLEMENTATION).toBe('portable')
  expect(hash.createSha256).toBe(portable.createSha256)
  expect(hash.sha256Hex).toBe(portable.sha256Hex)
})

await import('./ledger-integrity.test.js')
await import('./open-replay.test.js')
await import('./old-ledger.test.js')
await import('./fork-live-parent-anchor.test.js')

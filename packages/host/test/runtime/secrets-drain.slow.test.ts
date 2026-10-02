import { describe, expect, it } from 'vitest'
import {
  boundary,
  cleanup,
  consumer,
  error,
  must,
  resolveInput,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

describe.each(['default', 'reference'] as const)('%s bounded broker drain', (kind) => {
  it('reports an incomplete consumer drain, closes admission and releases storage after the consumer ends', async () => {
    const root = scratch()
    const auth = boundary()
    const broker = secrets(kind, root, auth, { drainMs: 15 })
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stalled = new Promise<void>((resolve) => {
      finish = resolve
    })
    try {
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const use = broker.use(locator, consumer, auth.call(), async () => {
        entered()
        await stalled
      })
      await started
      await expect(broker.close()).rejects.toThrow('Secret broker did not drain')
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_closed')
      finish()
      expect(error(await use)).toBe('cancelled/secret_cancelled')
    } finally {
      finish()
      cleanup(root)
    }
  })
})

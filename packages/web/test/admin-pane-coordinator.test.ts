import { describe, expect, it, vi } from 'vitest'
import { createPendingCoordinator } from '../src/admin-pane-coordinator.js'

describe('admin pane pending coordinator', () => {
  it('shares one in-flight operation for repeated clicks on the same pane', async () => {
    const coordinator = createPendingCoordinator<'resources' | 'plugin'>()
    const release = vi.fn<() => void>()
    let resolve!: () => void
    const operation = new Promise<void>((done) => {
      resolve = done
    })

    const first = coordinator.run('resources', async () => {
      release()
      await operation
    })
    const second = coordinator.run('resources', async () => {
      throw new Error('duplicate operation')
    })

    expect(second).toBe(first)
    expect(release).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
    resolve()
    await Promise.all([first, second])
    expect(coordinator.has('resources')).toBe(false)
  })
})

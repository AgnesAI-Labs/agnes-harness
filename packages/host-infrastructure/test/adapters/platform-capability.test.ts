import { describe, expect, it } from 'vitest'
import { createPosixPlatform } from '../../src/adapters/platform-posix.js'

describe('sandbox.l1 under a remote backend', () => {
  it('reports unavailable with a reason naming the remote boundary', () => {
    const p = createPosixPlatform()
    p.recordSandboxBackend({ name: 'remote', enforcement: { level: 'none', scope: [] } })
    const cap = p.capability('sandbox.l1')
    expect(cap.level).toBe('unavailable')
    expect(cap.reason).toMatch(/remote/i)
  })
})

import { expect, it, vi } from 'vitest'

it('defaults to the real PlatformBackend and never fabricates an identity for an unsupported OS', async () => {
  const { defaultProcessIdentity } = await import('../src/adapters/process-identity-default.js')
  const result = await defaultProcessIdentity(process.pid)
  if (['linux', 'darwin', 'win32'].includes(process.platform)) {
    // Real backends answer 'alive' for the caller's own live PID without injected deps.
    expect(result.state).toBe('alive')
  } else {
    expect(result).toEqual({ state: 'unknown', reason: 'unsupported platform' })
  }
})

it.each(['linux', 'darwin', 'win32'] as const)(
  'routes an injected platform.os=%s to exactly the matching backend, never another one',
  async (os) => {
    vi.resetModules()
    vi.doMock('../src/adapters/process-identity-linux.js', () => ({
      linuxProcessIdentity: async () => ({ state: 'alive', startId: 'linux-backend' }),
    }))
    vi.doMock('../src/adapters/process-identity-macos.js', () => ({
      macosProcessIdentity: async () => ({ state: 'alive', startId: 'macos-backend' }),
    }))
    vi.doMock('../src/adapters/process-identity-win32.js', () => ({
      windowsProcessIdentity: async () => ({ state: 'alive', startId: 'windows-backend' }),
    }))
    try {
      const { defaultProcessIdentity } = await import('../src/adapters/process-identity-default.js')
      const result = await defaultProcessIdentity(1, { os })
      if (os === 'linux') expect(result).toEqual({ state: 'alive', startId: 'linux-backend' })
      else if (os === 'darwin') expect(result).toEqual({ state: 'alive', startId: 'macos-backend' })
      else expect(result).toEqual({ state: 'alive', startId: 'windows-backend' })
    } finally {
      vi.doUnmock('../src/adapters/process-identity-linux.js')
      vi.doUnmock('../src/adapters/process-identity-macos.js')
      vi.doUnmock('../src/adapters/process-identity-win32.js')
      vi.resetModules()
    }
  },
)

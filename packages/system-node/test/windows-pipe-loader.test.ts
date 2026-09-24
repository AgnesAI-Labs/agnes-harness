import { afterEach, expect, it, vi } from 'vitest'

const requireNative = vi.hoisted(() => vi.fn())
vi.mock('node:module', () => ({ createRequire: () => requireNative }))
afterEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})
const windows = process.platform === 'win32' // guards-allow-platform: native loader validation on Windows.

it.runIf(windows).each(['missing', 'old-abi', 'missing-pipe'])(
  'rejects %s native pipe artifacts',
  async (mode) => {
    requireNative.mockImplementation(() => {
      if (mode === 'missing') throw new Error('MODULE_NOT_FOUND')
      return new Proxy(
        { abiVersion: mode === 'old-abi' ? 0 : 1 },
        {
          get: (target, key) =>
            key === 'abiVersion' ? target.abiVersion : key === 'reservePipeName' ? undefined : () => {},
        },
      )
    })
    const api = await import('../src/index.js')
    expect(() => api.windowsReservePipeName('pipe', 2)).toThrow(
      expect.objectContaining({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' }),
    )
    expect(() => api.windowsConnectPipeSync('pipe', 123, '456')).toThrow(
      expect.objectContaining({ code: 'E_SYSTEM_NATIVE_UNAVAILABLE' }),
    )
  },
)

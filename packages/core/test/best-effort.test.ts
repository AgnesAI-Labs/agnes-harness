import { describe, expect, it, vi } from 'vitest'
import { bestEffort } from '../src/best-effort.js'

describe('best-effort diagnostics', () => {
  it('preserves successful values and swallows failures with one sanitized record', async () => {
    const debug = vi.fn()
    const caught = bestEffort({ debug }, 'resource-close')
    expect(await Promise.resolve(42).catch(caught)).toBe(42)
    expect(debug).not.toHaveBeenCalled()
    const error = Object.assign(new Error('request body /virtual/secrets/auth/profiles/private'), {
      code: 'E_STORAGE_FAULT',
      cause: { password: ['synthetic', 'private-value'].join('-') },
    })
    expect(await Promise.reject(error).catch(caught)).toBeUndefined()
    expect(debug).toHaveBeenCalledExactlyOnceWith('best-effort resource-close failed', {
      code: 'E_STORAGE_FAULT',
    })
    debug.mockClear()
    for (const failure of [
      'synthetic-private-value',
      { code: '/virtual/secrets/auth/profiles/private' },
      new Proxy(
        {},
        {
          get() {
            throw new Error('unreadable exception')
          },
        },
      ),
    ]) {
      expect(await Promise.reject(failure).catch(caught)).toBeUndefined()
    }
    expect(debug.mock.calls).toEqual(
      Array(3).fill(['best-effort resource-close failed', { code: 'INTERNAL_ERROR' }]),
    )
  })

  it('isolates missing, throwing and rejecting diagnostic sinks', async () => {
    for (const log of [
      undefined,
      {
        debug() {
          throw new Error('sink unavailable')
        },
      },
      {
        debug: async () => {
          throw new Error('async sink unavailable')
        },
      },
    ]) {
      expect(
        await Promise.reject(new Error('original')).catch(bestEffort(log, 'resource-close')),
      ).toBeUndefined()
    }
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bestEffort } from '../src/supervisor/best-effort.js'
import { openRuntimeLog } from '../src/supervisor/runtime-log.js'

describe('best-effort diagnostics', () => {
  it('preserves successful values and swallows failures with one sanitized record', async () => {
    const debug = vi.fn()
    const caught = bestEffort(debug, 'worker-session-retire')
    expect(await Promise.resolve(42).catch(caught)).toBe(42)
    expect(debug).not.toHaveBeenCalled()
    const error = Object.assign(new Error('request body /virtual/secrets/auth/profiles/private'), {
      code: 'E_STORAGE_FAULT',
      cause: { password: ['synthetic', 'private-value'].join('-') },
    })
    expect(await Promise.reject(error).catch(caught)).toBeUndefined()
    expect(debug).toHaveBeenCalledExactlyOnceWith({
      kind: 'daemon.error',
      level: 'info',
      detail: { operation: 'worker-session-retire', code: 'E_STORAGE_FAULT' },
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
      Array(3).fill([
        {
          kind: 'daemon.error',
          level: 'info',
          detail: { operation: 'worker-session-retire', code: 'INTERNAL_ERROR' },
        },
      ]),
    )
  })

  it('isolates missing, throwing and rejecting diagnostic sinks', async () => {
    for (const log of [
      undefined,
      () => {
        throw new Error('sink unavailable')
      },
      async () => {
        throw new Error('async sink unavailable')
      },
    ]) {
      expect(
        await Promise.reject(new Error('original')).catch(bestEffort(log, 'worker-session-retire')),
      ).toBeUndefined()
    }
  })
})

it('persists closed operation labels and codes through the existing runtime sink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-best-effort-'))
  const log = openRuntimeLog(directory)
  try {
    await Promise.reject(
      Object.assign(new Error('/secrets/auth/profiles/synthetic'), {
        code: 'E_STORAGE_FAULT',
      }),
    ).catch(bestEffort(log.record, 'discovery-remove'))
    log.record({
      kind: 'daemon.error',
      detail: {
        operation: '/secrets/auth/profiles/synthetic',
        code: 'synthetic-private-value',
      },
    })
    await log.close()
    const bytes = readFileSync(join(directory, 'audit/runtime.jsonl'), 'utf8')
    expect(bytes).toContain('discovery-remove')
    expect(bytes).toContain('E_STORAGE_FAULT')
    expect(bytes).not.toContain('synthetic')
  } finally {
    await log.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

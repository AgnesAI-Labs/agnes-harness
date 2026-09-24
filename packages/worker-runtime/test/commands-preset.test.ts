import type { Host, HostSession } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { handleCommand } from '../src/commands.js'

describe('setPreset command', () => {
  it('routes a worker preset switch through Host instead of calling Core session directly', async () => {
    const setSessionPreset = vi.fn(async () => 42)
    const session = {
      key: 'session-a',
      setPreset: vi.fn(),
    } as unknown as HostSession
    const result = await handleCommand(
      session,
      {
        kind: 'command',
        requestId: 'request-a',
        method: 'setPreset',
        params: { preset: 'standard' },
      } as never,
      {
        host: { setSessionPreset } as unknown as Host,
        aborts: new Map(),
      },
    )
    expect(setSessionPreset).toHaveBeenCalledWith('session-a', 'standard')
    expect(session.setPreset).not.toHaveBeenCalled()
    expect(result).toEqual({ effectiveFromSeq: 42 })
  })
})

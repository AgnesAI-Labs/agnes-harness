import { type Host, type HostSession, resolveSessionCapabilities } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { handleCommand, handleServiceCommand } from '../src/commands.js'

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

it('exposes publication status and migration only through an assembled Host', async () => {
  const publication = {
    operation: 'models' as const,
    ok: false,
    recovery: 'retry-same-input' as const,
    containers: [{ compositionHash: 'writer', status: 'failed' as const }],
  }
  const result = { previousGenerationId: 'old', generationId: 'current', changed: true }
  const host = {
    compositionPublicationStatus: () => publication,
    migrateSessionGeneration: async (key: string) => {
      if (key !== 'closed') throw new Error('E_GENERATION_SESSION_OPEN')
      return result
    },
  } as unknown as Host
  const frame = (
    method: 'pluginGenerations.publicationStatus' | 'pluginGenerations.migrate',
    params = {},
  ) => ({ kind: 'command' as const, requestId: 'request', method, params })
  await expect(
    handleServiceCommand(host, frame('pluginGenerations.publicationStatus'), new Map()),
  ).resolves.toEqual({ publication })
  await expect(
    handleServiceCommand(host, frame('pluginGenerations.migrate', { sessionId: 'closed' }), new Map()),
  ).resolves.toEqual(result)
  await expect(
    handleServiceCommand(host, frame('pluginGenerations.migrate', { sessionId: 'open' }), new Map()),
  ).rejects.toThrow('E_GENERATION_SESSION_OPEN')
  await expect(
    handleServiceCommand(undefined, frame('pluginGenerations.migrate', { sessionId: 'closed' }), new Map()),
  ).rejects.toThrow('unavailable')
  await expect(
    handleServiceCommand({} as Host, frame('pluginGenerations.publicationStatus'), new Map()),
  ).resolves.toEqual({ publication: null })
})

it('returns the Host capability set with the tool catalog and accepts older Hosts', async () => {
  const catalog = { sessionId: 'inspect', tools: [], resources: [] }
  const session = { key: 'inspect', toolCatalog: () => catalog } as unknown as HostSession
  const frame = { kind: 'command' as const, requestId: 'inspect', method: 'toolCatalog' as const, params: {} }
  const capabilities = resolveSessionCapabilities({})
  await expect(
    handleCommand(session, frame, {
      aborts: new Map(),
      host: { sessionCapabilities: () => capabilities } as unknown as Host,
    }),
  ).resolves.toEqual({ ...catalog, capabilities })
  await expect(handleCommand(session, frame, { aborts: new Map(), host: {} as Host })).resolves.toEqual(
    catalog,
  )
})

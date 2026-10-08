import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError, type SystemPromptSnapshot } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerPromptTrace } from '../src/local/methods/prompt-trace.js'

it('requires local configuration authority and checks both session owners before reading comparison content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agh-prompt-rpc-'))
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const preview: SystemPromptSnapshot = {
    config: {},
    effect: 'new-sessions',
    hash: 'a'.repeat(64),
    sections: [],
    preview: 'default-sections',
  }
  registerPromptTrace(ep, {
    dataDir: dir,
    profile: 'test',
    registry: {
      require: () => {
        throw new Error('No live session needed')
      },
    },
    requireSessionOwner: (_method, key) => {
      if (key !== 'owned') throw rpcError('CAPABILITY_DENIED')
    },
    preview: async (config) => ({ ...preview, config }),
  })
  let id = 0
  const call = async (method: string, params: unknown) =>
    (await ep.handle({ jsonrpc: '2.0', id: ++id, method, params })) as {
      result?: unknown
      error?: { data?: { code?: string } }
    }
  try {
    expect(
      (await call('_agnes/v1/systemPrompt.save', { config: { personaPrefix: 'hello' } })).result,
    ).toMatchObject({ config: { personaPrefix: 'hello' } })
    expect(
      (
        await call('_agnes/v1/systemPrompt.save', {
          config: { fullOverride: 'replacement', personaPrefix: 'conflict' },
          confirmFullOverride: true,
        })
      ).error?.data?.code,
    ).toBe('CONFIG_INVALID_INPUT')
    ep.conn.authKind = 'jwt'
    ep.conn.credentialKind = 'jwt'
    expect((await call('_agnes/v1/systemPrompt.save', { config: {} })).error?.data?.code).toBe(
      'CAPABILITY_DENIED',
    )
    const callId = '00000000-0000-4000-8000-000000000000'
    expect((await call('_agnes/v1/trace.request', { sessionId: 'owned', callId })).result).toMatchObject({
      snapshot: null,
      unavailable: 'not-retained',
    })
    expect((await call('_agnes/v1/trace.clear', { sessionId: 'owned', callId })).result).toEqual({
      cleared: false,
    })
    expect((await call('_agnes/v1/trace.clear', { sessionId: 'stranger', callId })).error?.data?.code).toBe(
      'CAPABILITY_DENIED',
    )
    expect((await call('_agnes/v1/trace.request', { sessionId: 'stranger', callId })).error?.data?.code).toBe(
      'CAPABILITY_DENIED',
    )
    expect(
      (
        await call('_agnes/v1/trace.request', {
          sessionId: 'owned',
          callId,
          compare: { sessionId: 'stranger', callId },
        })
      ).error?.data?.code,
    ).toBe('CAPABILITY_DENIED')
  } finally {
    ep.close()
    await rm(dir, { recursive: true, force: true })
  }
})

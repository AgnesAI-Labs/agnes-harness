import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { SystemPromptSettingsStore } from '@agnes/host'
import type { SystemPromptSnapshot } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerPromptTrace } from '../src/local/methods/prompt-trace.js'

type Reply = {
  result?: SystemPromptSnapshot
  error?: { data?: { code?: string; current?: SystemPromptSnapshot } }
}

async function open() {
  const dir = await mkdtemp(join(tmpdir(), 'agh-prompt-revision-'))
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  registerPromptTrace(ep, {
    authority: localPackageAdminAuthority(),
    readOnly: async () => false,
    dataDir: dir,
    profile: 'test',
    registry: {
      require: () => {
        throw new Error('No live session needed')
      },
    },
    requireSessionOwner: () => undefined,
    preview: async (config) => ({
      config,
      effect: 'new-sessions',
      hash: 'a'.repeat(64),
      sections: [],
      preview: 'default-sections',
    }),
  })
  let id = 0
  const call = async (method: string, params: unknown) =>
    (await ep.handle({ jsonrpc: '2.0', id: ++id, method, params })) as Reply
  return { dir, call, settings: new SystemPromptSettingsStore(dir, 'test') }
}

it('a save that read an older revision is refused with the current value instead of overwriting it', async () => {
  const { dir, call, settings } = await open()
  try {
    // Two windows read the same defaults.
    const first = (await call('_agnes/v1/systemPrompt.get', {})).result
    const second = (await call('_agnes/v1/systemPrompt.get', {})).result
    expect(first?.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(second?.revision).toBe(first?.revision)

    const saved = await call('_agnes/v1/systemPrompt.save', {
      config: { personaPrefix: 'from window A' },
      expectedRevision: first?.revision,
    })
    expect(saved.result?.config).toEqual({ personaPrefix: 'from window A' })
    expect(saved.result?.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.result?.revision).not.toBe(first?.revision)

    const late = await call('_agnes/v1/systemPrompt.save', {
      config: { personaPrefix: 'from window B' },
      expectedRevision: second?.revision,
    })
    expect(late.error?.data?.code).toBe('CONFIG_REVISION_CONFLICT')
    expect(late.error?.data?.current).toMatchObject({
      config: { personaPrefix: 'from window A' },
      revision: saved.result?.revision,
    })
    expect(await settings.read()).toEqual({ personaPrefix: 'from window A' })

    // Re-read, then confirm: the save carries the revision it was made against and succeeds.
    const reread = (await call('_agnes/v1/systemPrompt.get', {})).result
    expect(reread?.revision).toBe(saved.result?.revision)
    expect(
      (
        await call('_agnes/v1/systemPrompt.save', {
          config: { personaPrefix: 'from window B' },
          expectedRevision: reread?.revision,
        })
      ).result?.config,
    ).toEqual({ personaPrefix: 'from window B' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('of two saves made against the same revision at the same time, exactly one is written', async () => {
  const { dir, call, settings } = await open()
  try {
    const base = (await call('_agnes/v1/systemPrompt.get', {})).result?.revision
    const replies = await Promise.all(
      ['A', 'B'].map((who) =>
        call('_agnes/v1/systemPrompt.save', { config: { personaPrefix: who }, expectedRevision: base }),
      ),
    )
    const won = replies.filter((reply) => reply.result)
    expect(won).toHaveLength(1)
    expect(replies.filter((reply) => reply.error?.data?.code === 'CONFIG_REVISION_CONFLICT')).toHaveLength(1)
    expect(await settings.read()).toEqual(won[0]?.result?.config)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

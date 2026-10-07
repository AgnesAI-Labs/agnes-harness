import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@agnes/cordis'
import { presetDefaults } from '@agnes/core'
import { fakeRequest } from '@agnes/ai/testkit'
import { expect, it } from 'vitest'
import { buildProvider } from '../../src/assemble/provider.js'
import { installModelAdapters, builtinModelAdaptersPlugin } from '../../src/assemble/model-adapters.js'
import { materializeRoutes } from '../../src/assemble/routes.js'
import { loadTemplate } from '../../src/profile/templates.js'
import { createTestHost } from '../../testkit/index.js'
import type { ResolvedProfile } from '../../src/profile/types.js'

it('runs the fresh local-dev demo through registry and provider without credentials, across repeated turns', async () => {
  const profile = loadTemplate('local-dev') as ResolvedProfile
  const routes = materializeRoutes(presetDefaults(), profile)
  expect(routes.primary).toEqual({ route: 'demo', model: 'demo-model' })
  const root = new Context()
  installModelAdapters(root)
  builtinModelAdaptersPlugin.apply(root)
  expect(root.modelAdapters.catalog().some((row) => row.id === 'scripted')).toBe(true)
  const built = await buildProvider(profile, routes, {
    modelAdapters: root.modelAdapters,
    secrets: () => {
      throw new Error('demo requested a credential')
    },
    clock: Date.now,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  try {
    expect(built.provider.models().some((model) => model.id === 'demo-model')).toBe(true)
    for (let turn = 0; turn < 2; turn++) {
      const events = []
      for await (const event of built.provider.infer(fakeRequest({ route: 'demo', model: 'demo-model' }), {
        signal: new AbortController().signal,
        toolNames: [],
      }))
        events.push(event)
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text_delta', delta: expect.stringContaining('[Demo model') }),
      )
      expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
    }
    const dataDir = await mkdtemp(join(tmpdir(), 'agh-demo-session-'))
    const { host } = await createTestHost({
      dataDir,
      provider: built.provider,
      disableSessionTitle: true,
      profileInputs: {
        user: { name: 'local-dev', provider: { package: '@agnes/ai', adapters: ['@agnes/ai', 'scripted'] } },
      },
    })
    try {
      const session = await host.createSession({ key: 'demo-session', cwd: dataDir })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor: session.d.actor })
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      const replies = await session.scan({ type: 'assistant/message', limit: 1 })
      expect(JSON.stringify(replies[0]?.data)).toContain('[Demo model')
    } finally {
      await host.close()
      await rm(dataDir, { recursive: true, force: true })
    }
    const aborted = new AbortController()
    aborted.abort()
    const instance = await root.modelAdapters.create('scripted', {
      routes: profile.provider.routes!.map((route) => ({ ...route, models: route.models ?? [] })),
    })
    await expect(async () => {
      for await (const _event of instance.adapter.stream('demo', fakeRequest(), {
        signal: aborted.signal,
        toolNames: [],
        sessionKey: 'abort',
        timeoutMs: { firstToken: 100, total: 100 },
      })) {
      }
    }).rejects.toThrow()
    await instance.dispose()
  } finally {
    await built.dispose()
    await root.fiber.dispose()
  }
})

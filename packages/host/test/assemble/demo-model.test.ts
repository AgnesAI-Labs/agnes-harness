import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRequest } from '@agnes/ai/testkit'
import { Context } from '@agnes/cordis'
import { presetDefaults } from '@agnes/core'
import { expect, it } from 'vitest'
import { builtinModelAdaptersPlugin, installModelAdapters } from '../../src/assemble/model-adapters.js'
import { buildProvider } from '../../src/assemble/provider.js'
import { materializeRoutes } from '../../src/assemble/routes.js'
import { demoProvider } from '../../src/profile/demo.js'
import { readConfigurationProfileInputs } from '../../src/profile/inputs.js'
import { loadTemplate } from '../../src/profile/templates.js'
import type { ResolvedProfile } from '../../src/profile/types.js'
import { createTestHost } from '../../testkit/index.js'
import { fixtureTool } from '../fixtures/tool.js'

it('runs the fresh local-dev demo through registry and provider without credentials, across repeated turns', async () => {
  const profile = { ...loadTemplate('local-dev'), provider: demoProvider() } as ResolvedProfile
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
        user: { name: 'local-dev', provider: demoProvider() },
      },
    })
    try {
      const session = await host.createSession({ key: 'demo-session', cwd: dataDir })
      session.currentTools().add(
        {
          ...fixtureTool('student_echo'),
          execute: async () => ({ content: [{ type: 'text', text: 'actual student result' }] }),
        },
        { source: 'student/echo', trust: 'trusted' },
      )
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'call student_echo' }],
        actor: session.d.actor,
      })
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      const replies = await session.scan({ type: 'assistant/message', order: 'desc', limit: 1 })
      expect(JSON.stringify(replies[0]?.data)).toContain('[Demo model')
      expect(JSON.stringify(replies[0]?.data)).toContain('actual student result')
      expect(await session.scan({ type: 'tool/result', limit: 1 })).toHaveLength(1)
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

it('adds the demo only for an opted-in fresh local-dev boot, preserving explicit provider declarations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-demo-profile-'))
  const options = { home, cwd: home, profile: 'local-dev', agnesVersion: '0.0.0' }
  try {
    expect(loadTemplate('local-dev').provider?.routes).toBeUndefined()
    expect((await readConfigurationProfileInputs(options)).user?.provider).toBeUndefined()
    const fresh = await readConfigurationProfileInputs({ ...options, demoFallback: true })
    expect(fresh.user?.provider).toEqual(demoProvider())
    for (const override of [
      { profile: 'enterprise' },
      { lock: { packages: {} } },
      { configuration: { composition: { loop: { id: 'custom', version: '1' } } } },
      { configuration: { provider: { package: '@agnes/ai', adapters: ['custom'] } } },
    ]) {
      const inputs = await readConfigurationProfileInputs({ ...options, demoFallback: true, ...override })
      expect(inputs.user?.provider?.routes).toBeUndefined()
    }
    const configured = {
      package: '@agnes/ai',
      adapters: ['scripted'],
      routes: [{ route: 'configured', api: 'scripted', baseUrl: 'https://demo.invalid' }],
    }
    expect(
      (
        await readConfigurationProfileInputs({
          ...options,
          demoFallback: true,
          configuration: { provider: configured },
        })
      ).user?.provider,
    ).toEqual(configured)
    await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true })
    await writeFile(join(home, 'profiles', 'local-dev', 'profile.yaml'), 'name: local-dev\n')
    expect(
      (await readConfigurationProfileInputs({ ...options, demoFallback: true })).user?.provider,
    ).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

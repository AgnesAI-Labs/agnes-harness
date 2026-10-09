import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRequest } from '@agnes/ai/testkit'
import { Context } from '@agnes/cordis'
import { presetDefaults } from '@agnes/core'
import { demoProvider } from '@agnes/host-common/profile/demo'
import { loadTemplate } from '@agnes/host-common/profile/templates'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  builtinModelAdaptersPlugin,
  installModelAdapters,
} from '@agnes/host-providers/assemble/model-adapters'
import { buildProvider } from '@agnes/host-providers/assemble/provider'
import { materializeRoutes } from '@agnes/host-providers/assemble/routes'
import { readConfigurationProfileInputs } from '../../src/runtime/profile/inputs.js'
import { currentCorrelation, observabilityPlugin } from '@agnes/observability'
import { memoryCollector } from '@agnes/observability/testkit'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it, vi } from 'vitest'
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
    const collector = await memoryCollector()
    vi.stubEnv('AGH_HOME', dataDir)
    const correlations: unknown[] = []
    const { host } = await createTestHost({
      dataDir,
      packages: {
        '@agnes/base': {
          plugins: [
            {
              declaration: {
                id: 'observability:otel',
                export: 'observabilityPlugin',
                apiRange: '^1.4.0',
                default: true,
                inject: ['providers'],
                provide: [],
                runtime: 'in-process',
                config: { enabled: true, endpoint: collector.endpoint },
              },
              entry: normalizePluginExport(observabilityPlugin),
            },
          ],
        },
      },
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
          execute: async () => {
            correlations.push(currentCorrelation())
            const child = await session.d.children.create({
              parent: session.key,
              cwd: dataDir,
              input: 'synthetic-private-child-body',
              start: false,
            })
            await child.run('synthetic-private-child-body')
            return { content: [{ type: 'text', text: 'actual student result' }] }
          },
        },
        { source: 'student/echo', trust: 'trusted' },
      )
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'call student_echo synthetic-private-prompt' }],
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
      await collector.close()
      vi.unstubAllEnvs()
      const payload = JSON.stringify(collector.requests)
      for (const secret of [
        'synthetic-private-prompt',
        'synthetic-private-child-body',
        'actual student result',
        dataDir,
      ])
        expect(payload).not.toContain(secret)
      type Span = {
        name: string
        traceId: string
        spanId: string
        parentSpanId?: string
        attributes: Array<{ key: string; value: unknown }>
      }
      const spans = collector.requests
        .filter((row) => row.path === '/v1/traces')
        .flatMap((row) =>
          (row.body.resourceSpans as Array<{ scopeSpans: Array<{ spans: Span[] }> }>).flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        )
      expect(spans.map((row) => row.name)).toEqual(
        expect.arrayContaining(['session', 'turn', 'model', 'tool', 'child']),
      )
      const tool = spans.find((row) => row.name === 'tool')!
      const turn = spans.find((row) => row.spanId === tool.parentSpanId)!
      expect(turn.name).toBe('turn')
      expect(tool.attributes).toEqual(
        expect.arrayContaining([
          { key: 'tool.id', value: { stringValue: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        ]),
      )
      expect(turn.attributes).toEqual(expect.arrayContaining([{ key: 'turn.id', value: { doubleValue: 1 } }]))
      expect(spans.find((row) => row.spanId === turn.parentSpanId)?.name).toBe('session')
      const child = spans.find((row) => row.name === 'child')!
      expect(child.traceId).toBe(turn.traceId)
      expect(child.parentSpanId).toBe(turn.spanId)
      expect(spans.some((row) => row.name === 'session' && row.parentSpanId === child.spanId)).toBe(true)
      expect(correlations).toContainEqual({ traceId: tool.traceId, spanId: tool.spanId })
      expect(collector.requests.some((row) => row.path === '/v1/metrics')).toBe(true)
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
    await writeFile(
      join(home, 'profiles', 'local-dev', 'bundle-selection.json'),
      JSON.stringify({ revision: 1, bundles: ['@agnes-fde/support-triage#support-triage'] }),
    )
    expect((await readConfigurationProfileInputs({ ...options, demoFallback: true })).user?.provider).toEqual(
      demoProvider(),
    )
    await writeFile(join(home, 'profiles', 'local-dev', 'profile.yaml'), 'name: local-dev\n')
    expect(
      (await readConfigurationProfileInputs({ ...options, demoFallback: true })).user?.provider,
    ).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

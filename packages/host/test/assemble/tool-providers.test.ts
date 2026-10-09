import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolPolicyPlugin } from '@agnes/base'
import { Context } from '@agnes/cordis'
import { installToolProviders } from '@agnes/host-providers/assemble/tool-providers'
import { expect, it } from 'vitest'
import { policy } from '../../../../examples/policies/read-only/index.mjs'
import { createTestHost } from '../../testkit/index.js'

it('assembles the bundled default policy row before opening a real Host session', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-tool-policy-'))
  const { host } = await createTestHost({
    dataDir,
    script: [],
    disableSessionTitle: true,
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [
          {
            id: '@agnes/code',
            source: 'builtin',
            config: {
              loop: { provider: 'agnes.default' },
              'tool-runtime': { provider: 'default' },
              'tool-policy': { provider: 'default' },
              compaction: { provider: 'default' },
              'child-agent': { provider: 'in-process' },
            },
          },
        ],
      },
    },
  })
  try {
    expect(host.kernel.toolPolicies.catalog()).toContainEqual({
      id: 'default',
      version: '1.0.0',
      sourcePackage: '@agnes/base',
    })
    const session = await host.createSession({ key: 'tool-policy', cwd: dataDir })
    expect(session.toolPolicy().id).toBe('default')
    expect(session.loop).toEqual({ id: 'agnes.default', version: '1.0.0' })
    const catalog = host.providers.catalog()
    expect(new Set(catalog.map((entry) => entry.kind))).toEqual(
      new Set([
        'loop',
        'model-adapter',
        'compaction',
        'persistence',
        'sandbox',
        'tool-runtime',
        'tool-policy',
        'child-agent',
      ]),
    )
    expect(catalog).toContainEqual(
      expect.objectContaining({ kind: 'persistence', id: 'sqlite', restartRequired: true, active: true }),
    )
    expect(catalog).toContainEqual(
      expect.objectContaining({ kind: 'tool-policy', id: 'default', active: true }),
    )
    expect(catalog).toContainEqual(
      expect.objectContaining({
        kind: 'child-agent',
        id: 'in-process',
        sourcePackage: '@agnes/base',
        active: true,
        restartRequired: false,
      }),
    )
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('registers the Base default and custom policies through plugin fibers and fails closed after unload', async () => {
  const root = new Context()
  installToolProviders(root)
  const builtin = root.plugin(toolPolicyPlugin)
  const reviewPorts = { reserve: () => true, model: async () => ({ text: '{}', model: 'script', cost: 0 }) }
  const custom = root.plugin((ctx) => {
    ctx.providers.register('tool-policy', '@agnes-example/read-only-policy', {
      ...policy,
      id: 'custom-read-only',
      settings: async (context, signal) => {
        signal.throwIfAborted()
        return { policy: context.policy, config: { owner: context.profile } }
      },
      decide: (input, signal, ports) => {
        expect(ports).toBe(reviewPorts)
        return policy.decide(input, signal)
      },
    })
  })
  await expect.poll(() => root.toolPolicies.catalog().length).toBe(4)
  expect(root.toolPolicies.catalog()).toContainEqual({
    id: 'default',
    version: '1.0.0',
    sourcePackage: '@agnes/base',
  })
  expect(root.toolRuntimes.catalog()).toContainEqual({
    id: 'default',
    version: '1.0.0',
    sourcePackage: '@agnes/core',
  })
  const selected = root.toolPolicies.resolve('custom-read-only')
  expect(
    await selected.settings!(
      { policy: 'custom-read-only', profile: 'custom', dataDir: '/synthetic', approvalMode: 'manual' },
      new AbortController().signal,
    ),
  ).toEqual({ policy: 'custom-read-only', config: { owner: 'custom' } })
  expect(
    await selected.decide(
      { policy: { isReadOnly: true, isDestructive: false } } as never,
      new AbortController().signal,
      reviewPorts,
    ),
  ).toMatchObject({ effect: 'allow' })
  expect(Object.isFrozen(root.toolPolicies.catalog()[0])).toBe(true)
  await custom.dispose()
  expect(() => root.toolPolicies.resolve('custom-read-only')).toThrow('not registered')
  await expect(selected.decide({} as never, new AbortController().signal)).rejects.toThrow()
  await expect(
    selected.settings!(
      { policy: 'custom-read-only', profile: 'custom', dataDir: '/synthetic', approvalMode: 'manual' },
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  await builtin.dispose()
  expect(() => root.toolPolicies.resolve('default')).toThrow('not registered')
  await root.fiber.dispose()
})

it('disposes loop event registrations with their owner', async () => {
  const root = new Context()
  installToolProviders(root)
  const plugin = root.plugin((ctx) => {
    ctx.loopEvents.on('before_model_request', () => ({ patch: { maxTokens: 21 } }))
  })
  const context = {
    session: { key: 's', lane: 'main', workspaceRoot: '/synthetic' },
    signal: new AbortController().signal,
  }
  const payload = {
    request: { model: 'm', slot: 'primary', messageCount: 1, toolNames: [], samplingParams: {} },
    slot: 'primary',
    model: 'm',
    attempt: 1,
  }
  await expect
    .poll(async () => root.loopEvents.dispatch('before_model_request', payload, context))
    .toEqual({ patch: { maxTokens: 21 } })
  await plugin.dispose()
  expect(await root.loopEvents.dispatch('before_model_request', payload, context)).toEqual({})
  await root.fiber.dispose()
})

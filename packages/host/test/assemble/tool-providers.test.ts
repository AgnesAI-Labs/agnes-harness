import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolPolicyPlugin } from '@agnes/base'
import { applyPlanCommand } from '@agnes/base/plan-mode'
import { Context } from '@agnes/cordis'
import { type ServiceDef, toolPolicyKind } from '@agnes/extension-api'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import { installToolProviders } from '@agnes/host-providers/assemble/tool-providers'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { policy } from '../../../../examples/policies/read-only/policy.mjs'
import { createTestHost } from '../../testkit/index.js'

it('assembles the bundled default policy row before opening a real Host session', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-tool-policy-'))
  mkdirSync(join(dataDir, '.agh'))
  writeFileSync(
    join(dataDir, '.agh/plan-mode.json'),
    JSON.stringify({
      active: true,
      instruction: 'existing plan',
      pendingPlan: 'existing pending plan',
      updatedAt: '2026-10-01T00:00:00Z',
    }),
  )
  const alternativeOwner = pluginRowSource('test:alternative-jobs')
  let controls = 0
  const alternativeControl: ServiceDef = {
    name: 'jobs.control',
    kind: 'effect',
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', additionalProperties: true },
    timeoutMs: 1000,
    maxResultBytes: 1024,
    async handler() {
      controls++
      return { opened: true }
    },
  }
  const { host } = await createTestHost({
    dataDir,
    script: [],
    serviceAuthority: {
      resolve: async () => ({
        source: 'session-workbench',
        subjectCredential: { kind: 'local' },
        grants: [{ extension: alternativeOwner, name: 'jobs.control', range: '*' }],
      }),
    },
    packages: {
      '@agnes/base': {
        plugins: [
          {
            declaration: {
              id: 'test:alternative-jobs',
              export: 'alternativeJobs',
              apiRange: '^5.0.0',
              default: true,
              inject: ['services'],
              runtime: 'in-process',
            },
            entry: normalizePluginExport({
              inject: ['services'],
              apply(ctx: import('@agnes/plugin-runtime').Context) {
                ctx.services.register(alternativeControl)
              },
            }),
          },
        ],
      },
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    disableSessionTitle: true,
    profileInputs: {
      user: {
        name: 'local-dev',
        providers: {
          loop: { provider: 'agnes.default' },
          'tool-runtime': { provider: 'default' },
          'tool-policy': { provider: 'default' },
          compaction: { provider: 'default' },
          'child-agent': { provider: 'in-process' },
        },
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
    expect(host.extensions().find((entry) => entry.id === 'agnes/plan-mode')).toMatchObject({ loaded: true })
    expect(host.providers.catalog().filter((entry) => entry.kind === 'workspace-state')).toHaveLength(1)
    const planInput = {
      sessionKey: session.key,
      workspaceRoot: session.workspaceRoot,
      cwd: session.workspaceRoot,
      actor: session.d.actor,
      call: { id: 'plan-write', name: 'shell', args: {} },
      policy: {
        isReadOnly: false,
        isDestructive: false,
        requiresApproval: 'never' as const,
        replay: 'never' as const,
        approvalScopes: [],
      },
      tainted: false,
      fullAccess: true,
      approvalMode: 'off' as const,
    }
    await expect(session.toolPolicy().decide(planInput, new AbortController().signal)).resolves.toMatchObject(
      { effect: 'deny' },
    )
    await expect(
      session
        .toolPolicy()
        .decide(
          { ...planInput, call: { ...planInput.call, name: 'exit_plan_mode' } },
          new AbortController().signal,
        ),
    ).resolves.toMatchObject({
      effect: 'ask',
      approval: {
        reviewerRequirement: 'human',
        grantConstraints: 'once',
        subjectRevision: expect.any(String),
      },
    })
    await expect(host.resolveService(session.key, ['plan.status', 'plan.command'])).resolves.toMatchObject({
      extension: pluginRowSource('service:plan-mode'),
    })

    await expect(
      host.callService(
        {
          sessionId: session.key,
          extension: alternativeOwner,
          service: 'jobs.control',
          commandId: 'refused-open',
          input: { operation: 'open' },
        },
        { kind: 'local' },
        undefined,
        { commandId: 'refused-open' },
      ),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(controls).toBe(0)
    expect(session.loop).toEqual({ id: 'agnes.default', version: '1.0.0' })
    const catalog = host.providers.catalog()
    expect(new Set(catalog.map((entry) => entry.kind))).toEqual(
      new Set([
        'approval',
        'artifacts',
        'billing',
        'checkpoint',
        'principals',
        'repair',
        'verifier',
        'loop',
        'model-adapter',
        'compaction',
        'git-worktree',
        'persistence',
        'sandbox',
        'platform',
        'tool-runtime',
        'tool-policy',
        'child-agent',
        'workspace-state',
        'intelligent-ui',
        'deferred-producer',
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
    applyPlanCommand(session.workspaceRoot, '/plan off')
    await expect(
      host.callService(
        {
          sessionId: session.key,
          extension: alternativeOwner,
          service: 'jobs.control',
          commandId: 'allowed-open',
          input: { operation: 'open' },
        },
        { kind: 'local' },
        undefined,
        { commandId: 'allowed-open' },
      ),
    ).resolves.toEqual({ output: { opened: true } })
    expect(controls).toBe(1)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('registers the Base default and custom policies through plugin fibers and fails closed after unload', async () => {
  const root = new Context()
  installToolProviders(root)
  // Every fiber of this bare tree stands for a bundled @agnes/base row.
  root.providers.verifyRows({
    lookup: () => ({ trustTier: 'builtin', packageId: 'builtin', ownerPackage: '@agnes/base' }),
  } as never)
  const builtin = root.plugin(toolPolicyPlugin)
  let planActive = true
  const planDependency = root.plugin({
    provide: ['planMode'],
    apply(ctx: Context) {
      ctx.provide('planMode', {
        status: () => ({ active: planActive, revision: 'fixture-revision', updatedAt: '' }),
      })
    },
  })
  const reviewPorts = { reserve: () => true, model: async () => ({ text: '{}', model: 'script', cost: 0 }) }
  const custom = root.plugin((ctx) => {
    ctx.providers.registerHost(toolPolicyKind, '@agnes-example/read-only-policy', {
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
  await expect
    .poll(() => root.providers.catalog().filter((entry) => entry.kind === 'tool-policy').length)
    .toBe(5)
  const safety = {
    workspaceRoot: '/synthetic',
    call: { name: 'write' },
    policy: { isReadOnly: false, requiresApproval: 'never' },
    tainted: false,
    fullAccess: true,
    approvalMode: 'off',
  } as never
  await expect(
    Promise.resolve(
      root.providers.resolve(toolPolicyKind, 'default').decide(safety, new AbortController().signal),
    ),
  ).resolves.toMatchObject({ effect: 'deny' })
  planActive = false
  await expect(
    Promise.resolve(
      root.providers.resolve(toolPolicyKind, 'default').decide(safety, new AbortController().signal),
    ),
  ).resolves.toMatchObject({ effect: 'allow' })
  expect(root.providers.catalog().filter((entry) => entry.kind === 'tool-policy')).toContainEqual(
    expect.objectContaining({
      id: 'default',
      version: '1.0.0',
      sourcePackage: '@agnes/base',
    }),
  )
  expect(root.providers.catalog().filter((entry) => entry.kind === 'tool-runtime')).toContainEqual(
    expect.objectContaining({
      id: 'default',
      version: '1.0.0',
      sourcePackage: '@agnes/core',
    }),
  )
  planActive = true
  await planDependency.dispose()
  await expect
    .poll(
      async () =>
        (await root.providers.resolve(toolPolicyKind, 'default').decide(safety, new AbortController().signal))
          .effect,
    )
    .toBe('allow')
  const selected = root.providers.resolve(toolPolicyKind, 'custom-read-only')
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
  expect(Object.isFrozen(root.providers.catalog().filter((entry) => entry.kind === 'tool-policy')[0])).toBe(
    true,
  )
  await custom.dispose()
  expect(() => root.providers.resolve(toolPolicyKind, 'custom-read-only')).toThrow('not registered')
  await expect(selected.decide({} as never, new AbortController().signal)).rejects.toThrow()
  await expect(
    selected.settings!(
      { policy: 'custom-read-only', profile: 'custom', dataDir: '/synthetic', approvalMode: 'manual' },
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  await builtin.dispose()
  expect(() => root.providers.resolve(toolPolicyKind, 'default')).toThrow('not registered')
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

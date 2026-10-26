import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin } from '@agnes/base'
import { defaultIds, type EventInput, hasChildControl, SessionLogImpl } from '@agnes/core'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  emptyLock,
  hashDirectory,
  type LockEntry,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
  readLock,
  writeLock,
} from '@agnes/package-manager'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { DecisionSnapshot } from '@agnes/protocol'
import {
  createSkillCandidateRegistry,
  restoreSkillGeneration,
  type SkillGenerationSnapshot,
} from '@agnes/resource-control-runtime'
import { expect, it, vi } from 'vitest'
import { answeredDecision, pendingDecision } from '../../core-ledger/testkit/decision.js'
import { createGenerationSkills } from '../src/runtime/generation/resources.js'
import { pinnedBindings } from '../src/runtime/generation/seam-pins.js'
import { hostInspectionSource } from '../src/runtime/lifecycle/host-facade.js'
import { createTestHost } from '../testkit/index.js'
import { fixtureTool } from './fixtures/tool.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing generation fixture value')
  return value
}

it('keeps an in-flight turn on old plugin code across update, close and cold resume, and drains on deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generations-'))
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  const sources: RuntimePluginSnapshot[] = []
  const makeSource = (version: string, digit: string) => {
    const directory = join(root, `package-${digit}`)
    mkdirSync(directory)
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'acme/generation',
        version,
        main: './index.js',
        agnes: {
          plugins: [
            {
              export: 'main',
              apiRange: '^5.0.0',
              inject: ['hooks', 'eventLog', 'self'],
              configReload: 'live',
              config: version === '1.0.0' ? { limit: 100 } : { limit: 2 },
              configSchema:
                version === '1.0.0'
                  ? {
                      type: 'object',
                      required: ['limit'],
                      additionalProperties: false,
                      properties: { limit: { type: 'number', minimum: 10 } },
                    }
                  : {
                      type: 'object',
                      required: ['limit'],
                      additionalProperties: false,
                      properties: { limit: { type: 'number', minimum: 0 } },
                    },
            },
          ],
        },
      }),
    )
    writeFileSync(join(directory, 'index.js'), version)
    const integrity = `sha256-${digit.repeat(64)}`
    const source: RuntimePluginSnapshot = {
      snapshot: {
        snapshotId: integrity,
        profile: 'local-dev',
        packageId: 'acme/generation',
        version,
        integrity,
        treeIntegrity: hashDirectory(directory, { exclude: [] }),
        capabilityHash: capabilityHash({ dependencies: {} }),
        directory,
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
    sources.push(source)
    return source
  }
  const profileDir = join(root, 'profiles/local-dev')
  mkdirSync(profileDir, { recursive: true })
  const persistTrust = (source: RuntimePluginSnapshot, trusted = true) => {
    const entry: LockEntry = {
      version: source.snapshot.version,
      source: { type: 'file', ref: 'file:fixture' },
      integrity: source.snapshot.integrity,
      treeIntegrity: source.snapshot.treeIntegrity,
      trust: 'trusted',
      license: 'MIT',
      apiRange: '^5.0.0',
      dependencies: {},
      previous: null,
      state: {
        installed: new Date(0).toISOString(),
        trusted: trusted ? new Date(0).toISOString() : null,
        enabled: false,
      },
      ...(trusted
        ? {
            trustDecision: {
              integrity: source.snapshot.integrity,
              capabilityHash: source.snapshot.capabilityHash,
              decidedAt: new Date(0).toISOString(),
            },
          }
        : {}),
    }
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      packages: { 'acme/generation': entry },
    })
  }
  const one = makeSource('1.0.0', '1'),
    two = makeSource('2.0.0', '2')
  let enter!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  let holdOldTurn = true
  const providers: ScriptedProvider[] = []
  const options = {
    dataDir: root,
    packages: {
      '@agnes/base': {
        plugins: [
          {
            export: 'defaultLoopPlugin',
            id: 'loop:agnes.default',
            inject: ['loops'],
            entry: defaultLoopPlugin,
          },
          { export: 'memoryPlugin', id: 'memory:file', inject: ['providers'], entry: memoryPlugin },
        ].map(({ entry, ...declaration }) => ({
          declaration: {
            ...declaration,
            apiRange: '^5.0.0',
            default: true,
            provide: [],
            runtime: 'in-process' as const,
          },
          entry: normalizePluginExport(entry),
        })),
      },
    },
    limits: { 'worker.generation_idle_close_ms': 25 },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    skillResources: {
      list: () => [],
      read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
      readFile: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
    },
    provider: (profile: ResolvedProfile) => {
      const provider = new ScriptedProvider({
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
        scripts: [
          [
            {
              type: 'toolcall_end',
              call: { toolUseId: '', name: 'generation_value', args: {}, ordinal: 0 },
              via: 'native',
            },
            { type: 'done', reason: 'toolUse' },
          ],
          [
            { type: 'text_delta', delta: 'old turn completed' },
            { type: 'done', reason: 'stop' },
          ],
          [
            {
              type: 'toolcall_end',
              call: { toolUseId: '', name: 'generation_value', args: {}, ordinal: 0 },
              via: 'native',
            },
            { type: 'done', reason: 'toolUse' },
          ],
          [
            { type: 'text_delta', delta: 'new turn completed' },
            { type: 'done', reason: 'stop' },
          ],
        ],
        onExhausted: 'error',
      })
      providers.push(provider)
      return provider
    },
    disableSessionTitle: true,
    runtimePluginSources: async () => sources,
    extensionLoader: {
      async import(file: string) {
        const version = readFileSync(file, 'utf8')
        if (version === 'broken') throw new Error('fixture activation refused')
        return {
          main: defineAgnesPlugin({
            inject: ['hooks', 'eventLog', 'self'],
            apply(ctx: Context, config: { limit?: number } | undefined) {
              if (!config || typeof config.limit !== 'number' || (version === '1.0.0' && config.limit < 10))
                throw new Error('fixture code received configuration from the wrong version')
              ctx.tools.register({
                ...fixtureTool('generation_value'),
                description: version,
                execute: async (_args, context) => {
                  if (context.session.key === 'session-a' && holdOldTurn) {
                    holdOldTurn = false
                    enter()
                    await release
                  }
                  return { content: [{ type: 'text', text: version }], structured: config }
                },
              })
            },
          }),
        }
      },
    },
  }
  try {
    persistTrust(one)
    host = (await createTestHost(options)).host
    const base = required(host.runtimeTargetSnapshot?.())
    const target = (source?: RuntimePluginSnapshot, config?: unknown) =>
      buildCompleteRuntimeTarget({
        rows: [
          ...base.tree.rows,
          ...(source
            ? [
                createPluginRow({
                  id: 'ext:acme/generation/main',
                  plugin: `acme/generation@${source.snapshot.snapshotId}/main`,
                  snapshotDigest: source.snapshot.integrity,
                  exportName: 'main',
                  entryRevision: source.snapshot.integrity,
                  extrasRevision: 'none',
                  mountRevision: 'v1',
                  inject: ['hooks', 'eventLog', 'self'],
                  configReload: 'live',
                  config: config ?? (source.snapshot.version === '1.0.0' ? { limit: 100 } : { limit: 2 }),
                }),
              ]
            : []),
        ],
        resources: { mcp: [], skills: {} },
      }).target
    await expect(host.applyRuntimeTarget(target(one))).resolves.toMatchObject({ ok: true })
    const a = await host.createSession({ key: 'session-a', cwd: root })
    const kernelAdmission = host.kernel.session
    expect(a.currentTools().resolve('skill_read')).toBeDefined()
    const firstId = a.pluginGenerationId
    await a.enqueue('next-turn', { actor: a.d.actor, content: [{ type: 'text', text: 'run the old code' }] })
    const inFlight = a.run({ until: 'turn-end', signal: new AbortController().signal })
    await Promise.race([
      entered,
      inFlight.then(() => {
        throw new Error('old tool never entered')
      }),
    ])
    persistTrust(two)
    const reload = await required(host.reloadPlugin)('acme/generation', two.snapshot.directory)
    expect(reload.changed).toBe(true)
    expect(await required(host.reloadPlugin)('acme/generation')).toEqual({ ...reload, changed: false })
    // A new, unbound container must also accept subsequent installed code publications.
    await expect(host.applyRuntimeTarget(target(one))).resolves.toMatchObject({ ok: true })
    await expect(host.applyRuntimeTarget(target(two))).resolves.toMatchObject({ ok: true })
    const b = await host.createSession({ key: 'session-b', cwd: root })
    // Compositions can own different Hosts. Inspect the bound session's public memory view.
    const pinnedMemory = required(a.d.memory)
    const inspectedMemory = required(host.memory(root, a.key))
    expect(inspectedMemory.root).toBe(pinnedMemory.root)
    expect(await inspectedMemory.inspect()).toEqual(await pinnedMemory.inspect())
    expect(a.currentTools().resolve('skill_read')).toBeDefined()
    expect(b.currentTools().resolve('skill_read')).toBeDefined()
    expect(a.pluginGenerationId).toBe(firstId)
    const oldRuntime = required(host.sessionRuntime)(a.key)
    const newerId = required(oldRuntime.generation?.newer?.id)
    expect(
      host.pluginGenerationStatus?.().generations.find((entry) => entry.id === newerId)?.packages,
    ).toContainEqual({ id: 'acme/generation', version: '2.0.0' })
    expect(oldRuntime.generation).toEqual({
      id: firstId,
      current: false,
      state: 'draining',
      newer: { id: newerId, effect: 'new-sessions' },
    })
    expect(required(host.sessionRuntime)(b.key).generation).toEqual({
      id: b.pluginGenerationId,
      current: true,
      state: 'active',
    })
    expect(host.pluginGenerationStatus?.().generations.find((item) => item.id === firstId)?.sessions).toEqual(
      [{ key: a.key, open: true }],
    )
    expect(await a.scan({ type: 'tool/result', limit: 10 })).toEqual([])
    resume()
    expect((await inFlight).reason).toBe('completed')
    expect(JSON.stringify((await a.scan({ type: 'tool/result', limit: 10 }))[0]?.data)).toContain('1.0.0')
    await b.enqueue('next-turn', { actor: b.d.actor, content: [{ type: 'text', text: 'run the new code' }] })
    expect((await b.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(JSON.stringify((await b.scan({ type: 'tool/result', limit: 10 }))[0]?.data)).toContain('2.0.0')
    const oldRequests = providers
      .flatMap((provider) => provider.calls)
      .filter((request) => request.sessionKey === a.key)
    expect(oldRequests).toHaveLength(2)
    for (const request of oldRequests)
      expect(request.tools).toContainEqual(
        expect.objectContaining({ name: 'generation_value', description: '1.0.0' }),
      )
    const execute = (session: typeof a) =>
      required(session.currentTools().resolve('generation_value')).execute({}, {
        signal: new AbortController().signal,
        net: {
          fetch: async () => {
            throw new Error('generation fixture tools do not use network')
          },
        },
        session: {
          key: session.key,
          lane: session.lane,
          workspaceRoot: root,
          toolUseId: 'test',
          depth: 0,
          generationDepth: 0,
        },
      } as never)
    expect(await execute(a)).toMatchObject({ content: [{ text: '1.0.0' }] })
    expect(await execute(b)).toMatchObject({ content: [{ text: '2.0.0' }] })
    expect(b.pluginGenerationId).not.toBe(firstId)
    writeFileSync(join(two.snapshot.directory, 'index.js'), 'broken')
    await expect(required(host.reloadPlugin)('acme/generation')).rejects.toThrow('E_PACKAGE_STATE')
    const failed = required(host.pluginGenerationStatus?.()).generations.find(
      (item) => item.state === 'failed',
    )
    expect(failed?.boundSessions).toBe(0)
    const status = required(host.pluginGenerationStatus?.())
    expect(status.plugins.find((entry) => entry.id === 'acme/generation')).toMatchObject({ state: 'active' })
    expect(
      status.generations.find((entry) => entry.id === status.currentGenerationId)?.packages,
    ).toContainEqual({ id: 'acme/generation', version: '2.0.0' })
    expect(() =>
      new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev')).read(required(failed).id),
    ).toThrow('E_GENERATION_SNAPSHOT_MISSING')
    expect(await execute(b)).toMatchObject({ content: [{ text: '2.0.0' }] })
    writeFileSync(join(two.snapshot.directory, 'index.js'), '2.0.0')
    // A pinned v1 accepts live 100 -> 10, then v2 publishes a different config schema.
    await expect(host.applyRuntimeTarget(target(one))).resolves.toMatchObject({ ok: true })
    expect(await execute(a)).toMatchObject({ structured: { limit: 100 } })
    await expect(host.applyRuntimeTarget(target(one, { limit: 10 }))).resolves.toMatchObject({ ok: true })
    expect(await execute(a)).toMatchObject({ structured: { limit: 10 } })
    const acceptedStore = new RuntimeGenerationSnapshotStore(profileDir)
    const acceptedBefore = required(acceptedStore.liveConfig(required(firstId)))
    const refusedConfig = target(one, { limit: 20 })
    // Refuse after live apply/record when code publication cannot resolve a candidate source.
    await expect(
      host.applyRuntimeTarget(
        buildCompleteRuntimeTarget({
          rows: [
            ...refusedConfig.tree.rows,
            createPluginRow({
              id: 'ext:unavailable',
              plugin: 'missing@unavailable/main',
              snapshotDigest: 'missing',
              exportName: 'main',
              entryRevision: 'missing',
              extrasRevision: 'none',
              mountRevision: 'v1',
            }),
          ],
          resources: refusedConfig.resource.resources,
        }).target,
      ),
    ).rejects.toThrow('E_RUNTIME_TARGET_PLUGIN')
    expect(await execute(a)).toMatchObject({ structured: { limit: 10 } })
    expect(acceptedStore.liveConfig(required(firstId))?.digest).toBe(acceptedBefore.digest)
    await expect(host.applyRuntimeTarget(target(two))).resolves.toMatchObject({ ok: true })
    expect(await execute(a)).toMatchObject({ structured: { limit: 10 } })
    expect(await execute(b)).toMatchObject({ structured: { limit: 2 } })
    await expect(host.applyRuntimeTarget(target())).resolves.toMatchObject({ ok: true })
    const unbound = await host.createSession({ key: 'session-disabled', cwd: root })
    expect(unbound.currentTools().resolve('generation_value')).toBeUndefined()
    expect(required(host.pluginGenerationStatus?.()).plugins).toContainEqual({
      id: 'acme/generation',
      state: 'draining',
      boundSessions: 2,
      drainingSessions: 2,
      historicalSessions: 0,
    })
    expect(await execute(a)).toMatchObject({ content: [{ text: '1.0.0' }] })
    expect(host.pluginGenerationStatus?.().generations.find((item) => item.id === firstId)).toMatchObject({
      state: 'draining',
      openSessions: 1,
      live: true,
    })
    await a.close()
    // Automatic idle collection releases memory while the durable archive and the other session survive.
    await vi.waitFor(() =>
      expect(host?.pluginGenerationStatus?.().generations.find((item) => item.id === firstId)).toMatchObject({
        state: 'historical',
        boundSessions: 1,
        openSessions: 0,
        live: false,
      }),
    )
    expect(new RuntimeGenerationSnapshotStore(profileDir).read(required(firstId)).packages).toContainEqual({
      id: 'acme/generation',
      version: '1.0.0',
    })
    expect(host.kernel.get(b.key)).toBeDefined()
    expect(host.kernel.get(a.key)).toBeUndefined()
    expect(() => kernelAdmission(a.key, {} as never)).toThrow('E_GENERATION_NOT_LIVE')
    expect(() => host!.memory(root, a.key)).toThrow('E_GENERATION_NOT_LIVE')
    expect(
      (await host.readSessionRows(a.key, { limit: 3 })).some((row) => row.type === 'session/start'),
    ).toBe(true)
    const collectedResume = await host.createSession({ key: a.key, cwd: root })
    expect(collectedResume.pluginGenerationId).toBe(firstId)
    await collectedResume.enqueue('next-turn', {
      actor: collectedResume.d.actor,
      content: [{ type: 'text', text: 'run collected old code' }],
    })
    expect(
      (await collectedResume.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    const latestResult = (await collectedResume.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]
    expect(JSON.stringify(latestResult?.data)).toContain('1.0.0')
    expect(await execute(collectedResume)).toMatchObject({
      content: [{ text: '1.0.0' }],
      structured: { limit: 10 },
    })
    await collectedResume.close()
    await host.close()
    // Installed packages and the publisher's process cache disappear; only immutable snapshots remain.
    sources.splice(0)
    rmSync(one.snapshot.directory, { recursive: true })
    rmSync(two.snapshot.directory, { recursive: true })
    const configFile = join(acceptedStore.root, required(firstId), 'live-config.json')
    const configBytes = readFileSync(configFile, 'utf8')
    writeFileSync(configFile, '{invalid')
    host = (await createTestHost(options)).host
    await expect(host.createSession({ key: 'session-a', cwd: root })).rejects.toThrow(
      'E_GENERATION_CONFIG_INTEGRITY',
    )
    await host.close()
    writeFileSync(configFile, configBytes)
    host = (await createTestHost(options)).host
    const resumed = await host.createSession({ key: 'session-a', cwd: root })
    expect(resumed.pluginGenerationId).toBe(firstId)
    expect(await execute(resumed)).toMatchObject({ content: [{ text: '1.0.0' }], structured: { limit: 10 } })
    const store = new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev'))
    expect(store.session('session-a')?.loop).toEqual(resumed.loop)
    expect(store.read(required(firstId)).packages).toContainEqual({ id: 'acme/generation', version: '1.0.0' })
    await expect(store.recordLoop('session-a', { id: 'missing-loop', version: '9.0.0' })).rejects.toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    await expect(required(host.migrateSessionGeneration)('session-a')).rejects.toThrow(
      'E_GENERATION_SESSION_OPEN',
    )
    const savedPin = store.session('session-a')
    const oldFile = join(store.root, required(firstId), 'generation.json')
    const oldBytes = readFileSync(oldFile, 'utf8')
    await resumed.close()
    writeFileSync(oldFile, JSON.stringify({ ...JSON.parse(oldBytes), compatibility: 'different-deployment' }))
    await expect(required(host.migrateSessionGeneration)('session-a')).rejects.toThrow(
      'E_GENERATION_INCOMPATIBLE',
    )
    expect(store.session('session-a')).toEqual(savedPin)
    writeFileSync(oldFile, oldBytes)
    store.pin('idle-incompatible-loop', required(firstId), pinnedBindings(host.seamBindings()))
    await store.recordLoop('idle-incompatible-loop', { id: 'missing-loop', version: '9.0.0' })
    await expect(required(host.migrateSessionGeneration)('idle-incompatible-loop')).rejects.toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    expect(store.session('idle-incompatible-loop')?.generationId).toBe(firstId)
    await required(host.releaseSessionGeneration)('idle-incompatible-loop')
    const approval = pendingDecision('approval')
    const blocking: [string, (Pick<EventInput, 'type' | 'data'> & Partial<EventInput>)[]][] = [
      ['pending-decision', [{ type: 'decision/state', register: 'decision/state', data: approval }]],
      [
        'pending-decision',
        [
          { type: 'decision/state', register: 'decision/state', data: approval },
          { type: 'decision/state', register: 'decision/state', data: answeredDecision(approval, 2) },
        ],
      ],
      [
        'pending-user-answer',
        [
          {
            type: 'x/agnes/interaction/requested',
            origin: 'ext:agnes/interaction',
            trust: 'untrusted',
            data: { id: 'question', toolUseId: 'question', answer: null },
          },
        ],
      ],
      [
        'unfinished-background-job',
        [
          {
            type: 'tool/result',
            data: {
              toolUseId: 'shell',
              content: [],
              isError: false,
              enforcement: { level: 'none', scope: [] },
              authz: { decisionId: 'fixture' },
              structured: { jobId: 'shell-job', status: 'running' },
            },
          },
        ],
      ],
      [
        'unfinished-effect',
        [{ type: 'effect/intent', data: { effectId: 'effect', kind: 'tool', replay: 'never' } }],
      ],
      [
        'unfinished-tool-call',
        [{ type: 'tool/call', data: { toolUseId: 'call', name: 'shell', args: {}, ordinal: 0 } }],
      ],
      [
        'unfinished-deferred-invocation',
        [
          {
            type: 'x/agnes/deferred-invocations/state',
            data: { invocation: { id: 'invocation' }, state: 'queued' },
          },
        ],
      ],
      [
        'unknown-external-outcome',
        [
          { type: 'effect/settled', data: { effectId: 'effect', outcome: 'unknown' } },
          { type: 'effect/settled', data: { effectId: 'effect', outcome: 'aborted' } },
        ],
      ],
      ['recovery-required', [{ type: 'x/core/recovery-required', data: { recoveryRequired: true } }]],
      [
        'open-surface',
        [
          {
            type: 'x/agnes/intelligent-ui/surface.opened',
            origin: 'ext:agnes/intelligent-ui',
            trust: 'untrusted',
            data: { record: { status: 'open', surface: { id: 'surface' } } },
          },
        ],
      ],
      [
        'unfinished-ui-action',
        [
          {
            type: 'x/agnes/intelligent-ui/action.received',
            origin: 'ext:agnes/intelligent-ui',
            trust: 'untrusted',
            data: { record: { request: { commandId: 'cmd' }, receipt: { status: 'received' } } },
          },
        ],
      ],
      [
        'undelivered-ui-receipt',
        [
          {
            type: 'x/agnes/intelligent-ui/action.succeeded',
            origin: 'ext:agnes/intelligent-ui',
            trust: 'untrusted',
            data: { commandId: 'cmd', receipt: { status: 'succeeded' } },
          },
        ],
      ],
      ['unfinished-sub-agent', []],
      [
        'pending-worktree',
        [
          {
            type: 'x/agnes/subagent/worktree-created',
            origin: 'ext:agnes/subagent',
            trust: 'untrusted',
            data: { path: '/work/.worktrees/agnes-pending' },
          },
        ],
      ],
    ]
    for (const [caseIndex, [reason, facts]] of blocking.entries()) {
      const key = `migration-${reason}-${caseIndex}`
      store.pin(key, required(firstId), pinnedBindings(host.seamBindings()))
      const storage = host.kernel.o.storage
      const log = await SessionLogImpl.open({
        storage,
        key,
        writerRunId: key,
        ttlMs: 30000,
        ids: defaultIds(),
        clock: Date.now,
      })
      const events: EventInput[] = facts.map((fact) => ({
        type: fact.type,
        ...(fact.register ? { register: fact.register } : {}),
        data:
          reason === 'unfinished-deferred-invocation'
            ? { invocation: { id: 'invocation', sessionKey: key }, state: 'queued' }
            : fact.type === 'decision/state'
              ? (() => {
                  const decision = fact.data as DecisionSnapshot
                  return { ...decision, handle: { ...decision.handle, sessionId: key } }
                })()
              : fact.data,
        actor: resumed.d.actor,
        origin: fact.origin ?? 'system',
        trust: fact.trust ?? 'trusted',
        lane: 'main',
        ignorable: true,
      }))
      if (events.length) await log.append(events)
      if (reason === 'unfinished-sub-agent') {
        expect(hasChildControl(storage)).toBe(true)
        if (!hasChildControl(storage)) throw new Error('missing child control fixture')
        await storage.ensureRootScope(key, 1000000n)
        await log.append([
          {
            type: 'turn/start',
            data: { turn: 1, trigger: 'prompt' },
            actor: resumed.d.actor,
            origin: 'system',
            trust: 'trusted',
            lane: 'main',
          },
        ])
        expect(
          await storage.createDelegatedChild({
            childKey: `${key}/child`,
            parentKey: key,
            boundarySeq: log.lastSeq,
            creationId: 'migration-child',
            kind: 'spawn',
            rootTaskId: key,
            runtimeOwnerSessionKey: key,
            generationDepth: 1,
            generationLimit: 3,
            maxFanOut: 3,
            inputHash: 'child-input',
            inputText: 'fixture',
            cwd: root,
            actorId: resumed.d.actor.id,
            isolation: 'shared',
            workspaceId: 'workspace',
            treeCapMicro: 1000000n,
            childCapMicro: null,
            writerRunId: key,
          }),
        ).toMatchObject({ status: 'created' })
      }
      await log.close()
      const before = store.session(key)
      const beforeFacts = await storage.scan(key, { toSeq: log.lastSeq })
      const refusal = await required(host.migrateSessionGeneration)(key).then(
        () => {
          throw new Error(`migration unexpectedly allowed ${reason}`)
        },
        (error) => error,
      )
      expect(refusal).toMatchObject({
        code: 'E_GENERATION_EXECUTION_UNSETTLED',
        detail: {
          generationId: firstId,
          reasons: expect.arrayContaining([expect.objectContaining({ kind: reason })]),
        },
      })
      expect(store.session(key)).toEqual(before)
      expect(await storage.scan(key, { toSeq: log.lastSeq })).toEqual(beforeFacts)
      await required(host.releaseSessionGeneration)(key)
    }
    // A durable open chat turn with no tool/effect binding does not fence migration.
    const chatKey = 'migration-unfinished-chat'
    store.pin(chatKey, required(firstId), pinnedBindings(host.seamBindings()))
    const chatLog = await SessionLogImpl.open({
      storage: host.kernel.o.storage,
      key: chatKey,
      writerRunId: chatKey,
      ttlMs: 30000,
      ids: defaultIds(),
      clock: Date.now,
    })
    await chatLog.append([
      {
        type: 'turn/start',
        data: { turn: 1, trigger: 'prompt' },
        actor: resumed.d.actor,
        origin: 'system',
        trust: 'trusted',
        lane: 'main',
      },
      {
        type: 'x/agnes/subagent/worktree-created',
        data: { path: '/work/.worktrees/agnes-finished' },
        actor: resumed.d.actor,
        origin: 'ext:agnes/subagent',
        trust: 'untrusted',
        lane: 'main',
      },
      {
        type: 'x/agnes/subagent/worktree-removed',
        data: { path: '/work/.worktrees/agnes-finished', branchRetained: true },
        actor: resumed.d.actor,
        origin: 'ext:agnes/subagent',
        trust: 'untrusted',
        lane: 'main',
      },
    ])
    await chatLog.close()
    await expect(
      required(host.migrateSessionGeneration)(chatKey, { recoveryRequired: () => true }),
    ).rejects.toMatchObject({
      code: 'E_GENERATION_EXECUTION_UNSETTLED',
      detail: { reasons: [expect.objectContaining({ kind: 'recovery-required' })] },
    })
    expect(store.session(chatKey)?.generationId).toBe(firstId)
    expect(await required(host.migrateSessionGeneration)(chatKey)).toMatchObject({ changed: true })
    await required(host.releaseSessionGeneration)(chatKey)
    const migration = await required(host.migrateSessionGeneration)('session-a')
    expect(migration).toEqual({
      previousGenerationId: firstId,
      generationId: store.session('session-a')?.generationId,
      changed: true,
    })
    expect(migration.generationId).not.toBe(firstId)
    expect(store.read(migration.generationId).packages).not.toContainEqual({
      id: 'acme/generation',
      version: '1.0.0',
    })
    expect(store.session('session-a')?.loop).toEqual(savedPin?.loop)
    expect(store.session('session-a')?.generationId).toBe(migration.generationId)
    expect(await required(host.migrateSessionGeneration)('session-a')).toEqual({
      ...migration,
      previousGenerationId: migration.generationId,
      changed: false,
    })
    const migrated = await host.createSession({ key: 'session-a', cwd: root })
    expect(migrated.pluginGenerationId).toBe(migration.generationId)
    expect(migrated.currentTools().resolve('generation_value')).toBeUndefined()
    await migrated.close()
    host.kernel.sessions.delete(resumed.key)
    await required(host.releaseSessionGeneration)('session-a')
    expect(store.session('session-a')).toBeUndefined()
    expect(() => store.read(required(firstId))).toThrow('E_GENERATION_SNAPSHOT_MISSING')
    const secondId = required(store.session('session-b')).generationId
    const file = join(store.root, secondId, 'generation.json')
    const saved = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(saved), compatibility: 'incompatible-adapter-deployment' }),
    )
    await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toThrow(
      'E_GENERATION_INCOMPATIBLE',
    )
    expect(required(host.pluginGenerationStatus?.()).generations).toContainEqual(
      expect.objectContaining({ id: secondId, state: 'failed', boundSessions: 1 }),
    )
    expect((await required(host.pluginGenerationStatusAsync)()).generations).toContainEqual(
      expect.objectContaining({ id: secondId, state: 'failed', boundSessions: 1 }),
    )
    expect(
      required(host.pluginGenerationStatus?.()).plugins.find((entry) => entry.id === 'acme/generation')
        ?.state,
    ).not.toBe('failed')
    writeFileSync(file, saved)
    const recovered = await host.createSession({ key: 'session-b', cwd: root })
    expect(recovered.pluginGenerationId).toBe(secondId)
    expect(
      required(host.pluginGenerationStatus?.()).generations.find((entry) => entry.id === secondId)?.state,
    ).not.toBe('failed')
    await recovered.close()
    await host.close()
    persistTrust(two, false)
    host = (await createTestHost(options)).host
    await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toMatchObject({
      code: 'E_SESSION_VERSION_OLDER',
      message: expect.stringContaining('E_WORKSPACE_UNTRUSTED'),
      detail: { cause: 'E_WORKSPACE_UNTRUSTED', issue: 'older', sessionKey: 'session-b' },
    })
    for (const field of ['integrity', 'capabilityHash'] as const) {
      persistTrust(two)
      const lock = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
      const decision = required(lock.packages['acme/generation']?.trustDecision)
      decision[field] = field === 'integrity' ? `sha256-${'f'.repeat(64)}` : 'f'.repeat(64)
      writeLock(profileDir, lock)
      await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toThrow(
        'E_GENERATION_UNTRUSTED',
      )
    }
    for (const changed of [{ treeIntegrity: `sha256-${'f'.repeat(64)}` }, { version: '9.0.0' }]) {
      persistTrust(two)
      const lock = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })
      Object.assign(required(lock.packages['acme/generation']), changed)
      writeLock(profileDir, lock)
      await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toThrow(
        'E_GENERATION_UNTRUSTED',
      )
      expect(store.session('session-b')?.generationId).toBe(secondId)
    }
    expect(host.kernel.get('session-b')).toBeUndefined()
    expect(host.extensions().some((entry) => entry.id === 'acme/generation/main' && entry.loaded)).toBe(false)
    rmSync(join(store.root, secondId), { recursive: true })
    await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toThrow(
      'E_GENERATION_SNAPSHOT_MISSING',
    )
  } finally {
    resume()
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps code pins while reading live Skills after refresh and cold resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-skills-'))
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  // Disk resources own the reconstructible facade revision; runtime contributions own their plugin rows.
  const view = async (body: string) => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    const candidate = {
      resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
      name: 'pinned',
      description: 'Pinned instructions',
      revision: (body === 'old body' ? 'a' : body === 'new body' ? 'b' : 'c').repeat(64),
      capabilityHash: 'c'.repeat(64),
      sourceIdentity: {
        scope: 'workspace' as const,
        rootKey: 'workspace-agnes' as const,
        sourceId: 'a'.repeat(64),
      },
      priority: 500,
      body,
    }
    registry.replaceRoot('workspace-agnes', [candidate])
    registry.setControl({
      desired: [{ resourceId: candidate.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: candidate.resourceId,
          revision: candidate.revision,
          capabilityHash: candidate.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await registry.activate('disk-fixture', async () => undefined)
    return registry.snapshot()
  }
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    runtimePluginSources: async () => [],
  }
  try {
    host = (await createTestHost({ ...options, skillResources: await view('old body') })).host
    const a = await host.createSession({ key: 'skills-old', cwd: root })
    await host.refreshSkillRow(await view('new body'))
    const b = await host.createSession({ key: 'skills-new', cwd: root })
    expect(b.pluginGenerationId).toBe(a.pluginGenerationId)
    const read = (session: typeof a) =>
      required(session.currentTools().resolve('skill_read')).execute({ name: 'pinned' }, {
        signal: new AbortController().signal,
        session: {
          key: session.key,
          lane: session.lane,
          workspaceRoot: root,
          toolUseId: 'skills',
          depth: 0,
          generationDepth: 0,
        },
      } as never)
    expect(await read(a)).toMatchObject({ content: [{ text: expect.stringContaining('new body') }] })
    expect(await read(b)).toMatchObject({ content: [{ text: expect.stringContaining('new body') }] })
    const lastGoodTarget = required(host.runtimeTargetSnapshot?.())
    expect(lastGoodTarget.resource.rows['ext:agnes/skills']).not.toBeNull()
    await host.close()
    host = (await createTestHost({ ...options, skillResources: await view('current unrelated body') })).host
    expect(host.runtimeTargetSnapshot?.()?.resource.rows['ext:agnes/skills']?.liveResourceRevision).not.toBe(
      lastGoodTarget.resource.rows['ext:agnes/skills']?.liveResourceRevision,
    )
    // Cold worker boot replays the daemon's last-good target after assembling current resources.
    expect((await host.applyRuntimeTarget(lastGoodTarget)).publication?.ok).toBe(true)
    const jobs = host.extensionRows.prepare({ extensionId: 'agnes/jobs', entryRevision: 'jobs-v2' })
    // Publishing code rows must keep the current Skills importer, even with a stale resource row.
    expect(
      (
        await host.extensionRows.apply([
          ...host.extensionRows
            .current()
            .filter((row) => row.id !== jobs.id && row.id !== 'ext:agnes/skills'),
          jobs,
          required(lastGoodTarget.resource.rows['ext:agnes/skills'] ?? undefined),
        ])
      ).publication?.ok,
    ).toBe(true)
    const resumed = await host.createSession({ key: 'skills-old', cwd: root })
    expect(resumed.pluginGenerationId).toBe(a.pluginGenerationId)
    expect(await read(resumed)).toMatchObject({
      content: [{ text: expect.stringContaining('current unrelated body') }],
    })
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('reads live scoped Skills without granting another session its directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-workspace-'))
  const empty: SkillGenerationSnapshot = { version: 1, listed: [], entries: [] }
  let selected = empty
  const view = (name: string): SkillGenerationSnapshot => {
    const directory = join(root, name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'SKILL.md'), name)
    const actual: SkillGenerationSnapshot['listed'][number] = {
      kind: 'skill',
      resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
      name,
      description: name,
      revision: 'b'.repeat(64),
      sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
      priority: 500,
      resolution: { winner: true, shadowed: [] },
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
      stale: false,
    }
    return {
      version: 1,
      listed: [actual],
      entries: [{ resourceId: actual.resourceId, actual, body: name, directory, files: [] }],
    }
  }
  const views = new Map([
    ['a', view('first')],
    ['b', view('second')],
  ])
  const original = {
    ...restoreSkillGeneration(empty),
    list: () => restoreSkillGeneration(selected).list(),
    read: (...args: Parameters<ReturnType<typeof restoreSkillGeneration>['read']>) =>
      restoreSkillGeneration(selected).read(...args),
    generationSnapshot: () => selected,
    async scopeWorkspace<T>(key: string, _session: string, invoke: () => Promise<T>) {
      selected = required(views.get(key))
      try {
        return await invoke()
      } finally {
        selected = empty
      }
    },
  }
  try {
    const runtime = createGenerationSkills(original)
    expect(runtime.input.readRoots?.()).toEqual([])
    const own = join(root, 'first')
    await runtime.input.scopeWorkspace?.('a', 'a', async () => {
      expect(runtime.input.readRoots?.()).toEqual([own])
      expect(
        runtime.input.read(required(required(views.get('a')).listed[0]).resourceId, { sessionKey: 'a' }),
      ).toMatchObject({ ok: true, content: expect.stringContaining('first') })
      expect(
        runtime.input.read(required(required(views.get('a')).listed[0]).resourceId, { sessionKey: 'b' }),
      ).toEqual({
        ok: false,
        code: 'UNAUTHORIZED',
      })
    })
    views.set('a', required(views.get('b')))
    await runtime.input.scopeWorkspace?.('a', 'a', async () => {
      expect(runtime.input.readRoots?.()).toEqual([join(root, 'second')])
      expect(
        runtime.input.read(required(required(views.get('a')).listed[0]).resourceId, { sessionKey: 'a' }),
      ).toMatchObject({ ok: true, content: expect.stringContaining('second') })
    })
    const cold = createGenerationSkills(undefined)
    await cold.input.scopeWorkspace?.('a', 'a', async () => {
      expect(
        cold.input.read(required(required(views.get('a')).listed[0]).resourceId, { sessionKey: 'a' }),
      ).toEqual({
        ok: false,
        code: 'UNAUTHORIZED',
      })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports disposal failure without reusing the sealed container, and can cold resume its durable pin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-dispose-'))
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    limits: { 'worker.generation_idle_close_ms': 0 },
  })
  try {
    const session = await host.createSession({ key: 'dispose', cwd: root })
    const generationId = session.pluginGenerationId
    const source = hostInspectionSource(host)
    const call = source.activationBarrier.admit('service')
    const retained = call.retain()
    call.finish()
    const close = source.close.bind(source)
    vi.spyOn(source, 'close').mockImplementationOnce(async () => {
      await close()
      throw new Error('fixture disposal failure')
    })
    const jobs = host.extensionRows.prepare({ extensionId: 'agnes/jobs', entryRevision: 'dispose-jobs-v2' })
    await host.extensionRows.apply([
      ...host.extensionRows.current().filter((row) => row.id !== jobs.id),
      jobs,
    ])
    expect(
      host.pluginGenerationStatus?.().generations.find((item) => item.id === generationId),
    ).toMatchObject({ state: 'draining', openSessions: 1, live: true })
    await session.close()
    await host.collectPluginGenerations?.()
    try {
      expect(
        host.pluginGenerationStatus?.().generations.find((item) => item.id === generationId),
      ).toMatchObject({ live: true, openSessions: 0 })
    } finally {
      retained.finish()
    }
    await vi.waitFor(
      () =>
        expect(
          host.pluginGenerationStatus?.().generations.find((item) => item.id === generationId),
        ).toMatchObject({ state: 'failed', live: false }),
      { timeout: 5000 },
    )
    expect(
      host.pluginGenerationStatus?.().generations.find((item) => item.id === generationId),
    ).toMatchObject({
      state: 'failed',
      boundSessions: 1,
      openSessions: 0,
      live: false,
      error: 'E_GENERATION_DISPOSE',
    })
    const resumed = await host.createSession({ key: session.key, cwd: root })
    expect(resumed.pluginGenerationId).toBe(generationId)
    expect(
      host.pluginGenerationStatus?.().generations.find((item) => item.id === generationId),
    ).toMatchObject({ state: 'draining', openSessions: 1, live: true })
    await resumed.close()
  } finally {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

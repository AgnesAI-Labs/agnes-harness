import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { PluginExtensionAPI } from '@agnes/extension-api'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  emptyLock,
  hashDirectory,
  readLock,
  writeLock,
  type LockEntry,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import {
  createSkillCandidateRegistry,
  restoreSkillGeneration,
  type SkillGenerationSnapshot,
} from '@agnes/resource-control-runtime'
import { expect, it } from 'vitest'
import { createGenerationSkills } from '../src/runtime/generation/resources.js'
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
              apiRange: '^1.4.0',
              inject: ['extension'],
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
      trust: 'trusted',
      license: 'MIT',
      apiRange: '^1.4.0',
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
        [
          'approval',
          'checkpoint',
          'ledger',
          'sandbox',
          'verifier',
          'repair',
          'artifacts',
          'principals',
          'platform',
          'harness',
        ].map((name) => [name, '@agnes/base']),
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
            inject: ['extension'],
            apply(ctx, config) {
              const accepted = config as { limit?: number }
              if (typeof accepted?.limit !== 'number' || (version === '1.0.0' && accepted.limit < 10))
                throw new Error('fixture code received configuration from the wrong version')
              ;(ctx as unknown as { extension(): PluginExtensionAPI }).extension().registerTool({
                ...fixtureTool('generation_value'),
                description: version,
                execute: async (_args, context) => {
                  if (context.session.key === 'session-a' && holdOldTurn) {
                    holdOldTurn = false
                    enter()
                    await release
                  }
                  return { content: [{ type: 'text', text: version }], structured: accepted }
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
                  inject: ['extension'],
                  configReload: 'live',
                  config: config ?? (source.snapshot.version === '1.0.0' ? { limit: 100 } : { limit: 2 }),
                }),
              ]
            : []),
        ],
        resources: { mcp: [], skills: {} },
      }).target
    await host.applyRuntimeTarget(target(one))
    const a = await host.createSession({ key: 'session-a', cwd: root })
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
    await host.applyRuntimeTarget(target(one))
    await host.applyRuntimeTarget(target(two))
    const b = await host.createSession({ key: 'session-b', cwd: root })
    expect(a.pluginGenerationId).toBe(firstId)
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
    expect(required(host.pluginGenerationStatus?.()).currentGenerationId).toBe(b.pluginGenerationId)
    expect(() =>
      new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev')).read(required(failed).id),
    ).toThrow('E_GENERATION_SNAPSHOT_MISSING')
    expect(await execute(b)).toMatchObject({ content: [{ text: '2.0.0' }] })
    writeFileSync(join(two.snapshot.directory, 'index.js'), '2.0.0')
    // A pinned v1 accepts live 100 -> 10, then v2 publishes a different config schema.
    await host.applyRuntimeTarget(target(one))
    expect(await execute(a)).toMatchObject({ structured: { limit: 100 } })
    await host.applyRuntimeTarget(target(one, { limit: 10 }))
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
    await host.applyRuntimeTarget(target(two))
    expect(await execute(a)).toMatchObject({ structured: { limit: 10 } })
    expect(await execute(b)).toMatchObject({ structured: { limit: 2 } })
    await host.applyRuntimeTarget(target())
    const unbound = await host.createSession({ key: 'session-disabled', cwd: root })
    expect(unbound.currentTools().resolve('generation_value')).toBeUndefined()
    expect(required(host.pluginGenerationStatus?.()).plugins).toContainEqual({
      id: 'acme/generation',
      state: 'draining',
      boundSessions: 2,
      drainingSessions: 2,
    })
    expect(await execute(a)).toMatchObject({ content: [{ text: '1.0.0' }] })
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
    expect(() => store.recordLoop('session-a', { id: 'missing-loop', version: '9.0.0' })).toThrow(
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
    store.pin('idle-incompatible-loop', required(firstId))
    store.recordLoop('idle-incompatible-loop', { id: 'missing-loop', version: '9.0.0' })
    await expect(required(host.migrateSessionGeneration)('idle-incompatible-loop')).rejects.toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    expect(store.session('idle-incompatible-loop')?.generationId).toBe(firstId)
    await required(host.releaseSessionGeneration)('idle-incompatible-loop')
    const migration = await required(host.migrateSessionGeneration)('session-a')
    expect(migration).toEqual({
      previousGenerationId: firstId,
      generationId: host.pluginGenerationStatus?.().currentGenerationId,
      changed: true,
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
    writeFileSync(file, saved)
    await host.close()
    persistTrust(two, false)
    host = (await createTestHost(options)).host
    await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toMatchObject({
      code: 'E_WORKSPACE_UNTRUSTED',
      message: expect.stringContaining('E_GENERATION_UNTRUSTED'),
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

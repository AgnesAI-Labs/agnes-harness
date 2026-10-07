import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginExtensionAPI } from '@agnes/extension-api'
import {
  hashDirectory,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import {
  createSkillCandidateRegistry,
  restoreSkillGeneration,
  type SkillGenerationSnapshot,
} from '@agnes/resource-control-runtime'
import { defineAgnesPlugin } from '@agnes/plugin-runtime'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { expect, it } from 'vitest'
import { captureGenerationResources, createGenerationSkills } from '../src/runtime-generation-resources.js'
import { buildCompleteRuntimeTarget } from '../src/runtime-target-builder.js'
import { createTestHost } from '../testkit/index.js'
import { fixtureTool } from './fixtures/tool.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing generation fixture value')
  return value
}

it('keeps old plugin leases across update, close and cold resume, and drains on deletion', async () => {
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
        agnes: { plugins: [{ export: 'main', inject: ['extension'] }] },
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
        capabilityHash: integrity,
        directory,
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
    sources.push(source)
    return source
  }
  const one = makeSource('1.0.0', '1'),
    two = makeSource('2.0.0', '2')
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    runtimePluginSources: async () => sources,
    extensionLoader: {
      async import(file: string) {
        const version = readFileSync(file, 'utf8')
        return {
          main: defineAgnesPlugin({
            inject: ['extension'],
            apply(ctx) {
              ;(ctx as unknown as { extension(): PluginExtensionAPI }).extension().registerTool({
                ...fixtureTool('generation_value'),
                description: version,
                execute: async () => ({ content: [{ type: 'text', text: version }] }),
              })
            },
          }),
        }
      },
    },
  }
  try {
    host = (await createTestHost(options)).host
    const base = required(host.runtimeTargetSnapshot?.())
    const target = (source?: RuntimePluginSnapshot) =>
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
                }),
              ]
            : []),
        ],
        resources: { mcp: [], skills: {} },
      }).target
    await host.applyRuntimeTarget(target(one))
    const a = await host.createSession({ key: 'session-a', cwd: root })
    const firstId = a.pluginGenerationId
    const reload = await required(host.reloadPlugin)('acme/generation', two.snapshot.directory)
    expect(reload.changed).toBe(true)
    expect(await required(host.reloadPlugin)('acme/generation')).toEqual({ ...reload, changed: false })
    const b = await host.createSession({ key: 'session-b', cwd: root })
    const execute = (session: typeof a) =>
      required(session.currentTools().resolve('generation_value')).execute({}, {
        signal: new AbortController().signal,
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
    host = (await createTestHost(options)).host
    const resumed = await host.createSession({ key: 'session-a', cwd: root })
    expect(resumed.pluginGenerationId).toBe(firstId)
    expect(await execute(resumed)).toMatchObject({ content: [{ text: '1.0.0' }] })
    const store = new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev'))
    expect(store.session('session-a')?.loop).toEqual(resumed.loop)
    expect(store.read(required(firstId)).packages).toContainEqual({ id: 'acme/generation', version: '1.0.0' })
    expect(() => store.recordLoop('session-a', { id: 'missing-loop', version: '9.0.0' })).toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    await resumed.close()
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
    rmSync(join(store.root, secondId), { recursive: true })
    await expect(host.createSession({ key: 'session-b', cwd: root })).rejects.toThrow(
      'E_GENERATION_SNAPSHOT_MISSING',
    )
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('pins changed Skills bodies for old sessions after a cold resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-skills-'))
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  const view = (body: string) => {
    const registry = createSkillCandidateRegistry({
      barrier: { quiesce: async (_id, publish) => publish({}) },
    })
    registry.registerRuntime({
      resourceId: `skill/runtime/runtime/${'a'.repeat(64)}`,
      name: 'pinned',
      description: 'Pinned instructions',
      revision: body === 'old body' ? 'a'.repeat(64) : 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      sourceIdentity: { scope: 'runtime', rootKey: 'runtime', sourceId: 'a'.repeat(64) },
      priority: 450,
      body,
    })
    return registry.snapshot()
  }
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
  }
  try {
    host = (await createTestHost({ ...options, skillResources: view('old body') })).host
    const a = await host.createSession({ key: 'skills-old', cwd: root })
    await host.refreshSkillRow(view('new body'))
    const b = await host.createSession({ key: 'skills-new', cwd: root })
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
    expect(await read(a)).toMatchObject({ content: [{ text: expect.stringContaining('old body') }] })
    expect(await read(b)).toMatchObject({ content: [{ text: expect.stringContaining('new body') }] })
    await host.close()
    host = (await createTestHost({ ...options, skillResources: view('current unrelated body') })).host
    const resumed = await host.createSession({ key: 'skills-old', cwd: root })
    expect(resumed.pluginGenerationId).toBe(a.pluginGenerationId)
    expect(await read(resumed)).toMatchObject({ content: [{ text: expect.stringContaining('old body') }] })
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('restores scoped Skills privately without granting another session its archived directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-generation-workspace-'))
  const store = new RuntimeGenerationSnapshotStore(root)
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
    const target = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
    const snapshot = store.create(target, [], 'compatible', [], captureGenerationResources(original, []))
    const runtime = createGenerationSkills(original, store)
    runtime.seal(required(snapshot.resources), true)
    for (const key of views.keys()) {
      store.pin(key, snapshot.id)
      await runtime.bind(key, key, false)
    }
    expect(runtime.input.readRoots?.()).toEqual([])
    const own = required(store.sessionResources('a')).directories[0]
    await runtime.input.scopeWorkspace?.('a', 'a', async () => {
      expect(runtime.input.readRoots?.()).toEqual([own])
      expect(runtime.input.read(views.get('a')!.listed[0]!.resourceId, { sessionKey: 'b' })).toEqual({
        ok: false,
        code: 'UNAUTHORIZED',
      })
    })
    rmSync(join(root, 'first'), { recursive: true })
    const cold = createGenerationSkills(undefined, store)
    cold.seal(required(snapshot.resources), false)
    await cold.bind('a', 'a', true)
    await cold.input.scopeWorkspace?.('a', 'a', async () => {
      expect(cold.input.read(views.get('a')!.listed[0]!.resourceId, { sessionKey: 'a' })).toMatchObject({
        ok: true,
        content: expect.stringContaining('first'),
      })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

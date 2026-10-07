import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { mcpLocalToolPrefix, skillResourceIdAt } from '@agnes/base'
import { ToolRegistry } from '@agnes/core'
import { defineTool } from '@agnes/extension-api'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { RuntimeSecurityStatus, validateAgainst } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { expect, it, vi } from 'vitest'
import { assertHostPublication } from '../../src/host-facade.js'
import { parsePackageBundles } from '../../src/profile/composition.js'
import { CompositionSessionStore, readLiveCompositionSessions } from '../../src/profile/composition-state.js'
import {
  compositionModuleAllowed,
  compositionSkillOwners,
  compositionSkills,
  compositionSurfaceAllowed,
  compositionTools,
} from '../../src/profile/composition-visibility.js'
import type { SkillRuntimeInput } from '../../src/resources/skills.js'
import { createTestHost } from '../../testkit/index.js'

vi.mock('../../src/adapters/process-identity-default.js', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'composition-test-worker' }),
}))

it('runs preset compositions side by side, filters tools and retains the generation on cold reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-compositions-'))
  let refuseWriter = false
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    provider: (profile: import('../../src/profile/types.js').ResolvedProfile) => {
      if (refuseWriter && profile.compaction?.engine === 'fixture')
        throw new Error('writer model candidate refused')
      return new ScriptedProvider({
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
        scripts: [],
      })
    },
    profileInputs: {
      bundleCatalog: parsePackageBundles('@fixture/session', {
        reader: { profile: { tools: ['read'] } },
      }),
      user: {
        name: 'local-dev',
        composition: {},
        presets: { default: 'reader', allowed: ['reader', 'writer', 'observer'] },
      },
    },
    allowed: ['reader', 'writer', 'observer'],
    presets: {
      observer: { name: 'observer', extends: 'standard', composition: { tools: ['read', 'write'] } },
      reader: { name: 'reader', extends: 'standard', composition: { tools: ['read'] } },
      writer: {
        name: 'writer',
        extends: 'standard',
        composition: { tools: ['write'], compaction: { engine: 'fixture' } },
      },
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    packages: {
      '@agnes/code': {
        plugins: [
          {
            declaration: {
              id: 'compaction-engine:fixture',
              export: 'fixture',
              default: true,
              inject: ['compactionEngines'],
              provide: [],
              runtime: 'in-process' as const,
            },
            entry: normalizePluginExport({
              inject: ['compactionEngines'],
              apply(ctx) {
                ctx.compactionEngines.register({
                  id: 'fixture',
                  version: '1.0.0',
                  create: () => ({
                    shouldCompact: () => false,
                    compact: async () => null,
                  }),
                })
              },
            }),
          },
        ],
      },
    },
  }
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (await createTestHost(options)).host
    const reader = await host.createSession({ key: 'reader-session', preset: 'reader', cwd: root })
    const writer = await host.createSession({ key: 'writer-session', preset: 'writer', cwd: root })
    const security = host.securityStatus?.()
    expect(validateAgainst(RuntimeSecurityStatus, security).ok).toBe(true)
    expect(security?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: reader.key,
          path: realpathSync(root),
          preset: 'reader',
          provider: 'local',
        }),
        expect.objectContaining({
          sessionId: writer.key,
          path: realpathSync(root),
          preset: 'writer',
          provider: 'local',
        }),
      ]),
    )
    expect(JSON.stringify(security)).not.toContain('confine')
    expect(reader.pluginGenerationId).toBeTruthy()
    expect(writer.pluginGenerationId).not.toBe(reader.pluginGenerationId)
    expect(reader.currentTools().resolve('read')).toBeDefined()
    expect(reader.currentTools().resolve('write')).toBeUndefined()
    expect(writer.currentTools().resolve('write')).toBeDefined()
    expect(
      writer
        .currentTools()
        .snapshot(0)
        .defs.map((tool) => tool.name),
    ).toEqual(['write'])
    expect(host.kernel.get(reader.key)).toBe(reader)
    expect(host.kernel.get(writer.key)).toBe(writer)
    expect(host.compositionSessions?.()).toHaveLength(2)
    expect(
      host.compositionSessions?.().find((session) => session.sessionKey === writer.key)?.providers.compaction,
    ).toEqual({ engine: 'fixture' })
    await expect(host.setSessionPreset(reader.key, 'writer')).rejects.toThrow('separate Host generation')
    const observer = await host.createSession({
      key: 'observer-session',
      preset: 'observer',
      cwd: root,
      bundles: ['@fixture/session#reader'],
    })
    expect(observer.currentTools().resolve('write')).toBeUndefined()
    await expect(host.createSession({ key: observer.key, cwd: root, bundles: [] })).rejects.toThrow(
      'immutable',
    )
    await expect(
      host.createSession({ key: 'missing-bundle', cwd: root, bundles: ['missing#bundle'] }),
    ).rejects.toThrow('unknown bundle')
    const next = structuredClone(host.profile)
    const route = next.provider.routes?.find((route) => route.route === 'gw')
    const first = route?.models?.[0]
    if (!route || !first) throw new Error('fixture route missing')
    route.models = [...(route.models ?? []), { ...first, id: 'live-model', name: 'live-model' }]
    await expect(host.applyModelProfile({ ...next, dataDir: join(root, 'other-backend') })).rejects.toThrow(
      'non-model configuration requires restart',
    )
    refuseWriter = true
    const partial = await host.applyModelProfile(next)
    expect(partial).toMatchObject({
      operation: 'models',
      ok: false,
      recovery: 'retry-same-input',
      containers: [
        { status: 'applied' },
        { status: 'failed', error: expect.stringContaining('writer model candidate refused') },
        { status: 'applied' },
      ],
    })
    expect(() => assertHostPublication(partial)).toThrow('applied to 2/3 containers')
    expect(host.compositionPublicationStatus?.()).toEqual(partial)
    await reader.setModel({ slot: 'primary', route: route.route, model: 'live-model' })
    await expect(
      writer.setModel({ slot: 'primary', route: route.route, model: 'live-model' }),
    ).rejects.toThrow('E_MODEL_UNKNOWN')
    await observer.setModel({ slot: 'primary', route: route.route, model: 'live-model' })
    refuseWriter = false
    expect(await host.applyModelProfile(next)).toMatchObject({ ok: true })
    await writer.setModel({ slot: 'primary', route: route.route, model: 'live-model' })
    await observer.close()
    const profileDir = join(root, 'profiles', 'local-dev')
    // Use the same durable directory as createTestHost's production Host options.
    const bindings = new CompositionSessionStore(profileDir)
    expect(bindings.read(reader.key)?.tree.preset).toBe('reader')
    expect(bindings.read(observer.key)?.tree.sessionBundles).toEqual(['@fixture/session#reader'])
    expect(bindings.read(observer.key)?.tree.sources.tools).toEqual({
      layer: 'session',
      name: '@fixture/session#reader',
    })
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(2)
    const generation = reader.pluginGenerationId
    await reader.close()
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(1)
    await writer.close()
    await host.close()
    host = (await createTestHost(options)).host
    const resumed = await host.createSession({ key: 'reader-session', cwd: root })
    expect(resumed.pluginGenerationId).toBe(generation)
    expect(resumed.currentTools().resolve('write')).toBeUndefined()
    await resumed.close()
    const migration = await host.migrateSessionGeneration?.(resumed.key)
    expect(migration?.changed).toBe(true)
    expect(bindings.read(resumed.key)?.tree.preset).toBe('reader')
    const migrated = await host.createSession({ key: resumed.key, cwd: root })
    expect(migrated.pluginGenerationId).toBe(migration?.generationId)
    expect(migrated.currentTools().resolve('write')).toBeUndefined()
    await migrated.close()
    const bundledResume = await host.createSession({ key: observer.key, cwd: root })
    expect(bundledResume.currentTools().resolve('write')).toBeUndefined()
    await bundledResume.close()
    await host.releaseSessionGeneration?.(resumed.key)
    expect(bindings.read(resumed.key)).toBeUndefined()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('restricts Skill reads and optional panels to the selected resources and slots', () => {
  let listed = [
    { resourceId: 'visible', name: 'read' },
    { resourceId: 'hidden', name: 'write' },
  ]
  const input = {
    list: () => listed,
    read: () => ({ ok: true }),
    readFile: () => ({ ok: true }),
    readRoots: () => ['/broad'],
  } as unknown as SkillRuntimeInput
  const skills = compositionSkills(input, { skills: ['read'] })!
  expect(skills.list().map((skill) => skill.resourceId)).toEqual(['visible'])
  expect(skills.read('hidden', { sessionKey: 'fixture' })).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  expect(skills.readFile('hidden', 'revision', 'SKILL.md', { sessionKey: 'fixture' })).toEqual({
    ok: false,
    code: 'UNAUTHORIZED',
  })
  expect(skills.readRoots?.()).toEqual([])
  listed = [
    { resourceId: 'replacement', name: 'read' },
    { resourceId: 'added-hidden', name: 'write' },
  ]
  expect(skills.list().map((skill) => skill.resourceId)).toEqual(['replacement'])
  expect(skills.read('visible', { sessionKey: 'fixture' })).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  expect(skills.read('added-hidden', { sessionKey: 'fixture' })).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  const location = ['acme/skills', 'refund', 'skills/refund'].join('\0')
  const resourceId = skillResourceIdAt(
    { scope: 'package', rootKey: 'package', priority: 50, path: '' },
    location,
  )
  const owners = compositionSkillOwners([
    {
      snapshot: {
        packageId: 'acme/skills',
        contributions: [{ kind: 'skill', id: 'refund', path: 'skills/refund' }],
      },
    } as unknown as RuntimePluginSnapshot,
  ])
  expect([...owners]).toEqual([[resourceId, 'acme/skills']])
  const packageSkills = {
    ...input,
    list: () => [{ resourceId, name: 'refund' }],
  } as unknown as SkillRuntimeInput
  const denied = compositionSkills(
    packageSkills,
    { packages: [{ id: 'acme/skills', source: 'builtin:acme/skills', enabled: false }] },
    owners,
  )!
  expect(denied.list()).toEqual([])
  expect(denied.read(resourceId, { sessionKey: 'fixture' })).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  expect(
    compositionModuleAllowed({ shell: { slots: ['sidebar'] } }, { id: 'panel', slots: ['sidebar'] }),
  ).toBe(true)
  expect(
    compositionModuleAllowed(
      { shell: { slots: ['sidebar'] } },
      { id: 'panel', slots: ['sidebar', 'footer'] },
    ),
  ).toBe(false)
  expect(compositionModuleAllowed({ shell: { modules: [] } }, { id: 'panel' })).toBe(false)
  expect(compositionModuleAllowed({ surfaces: [] }, { id: 'panel' })).toBe(false)
  expect(compositionSurfaceAllowed(undefined, 'web')).toBe(true)
  expect(compositionSurfaceAllowed({ surfaces: [] }, 'acp')).toBe(false)
})

it('filters registered MCP identities without confusing slug collisions or long server ids', () => {
  const registry = new ToolRegistry()
  const ids = ['a.b', 'a_b', 'My.Server--2', '...', 'long-'.repeat(30)]
  for (const id of ids)
    registry.add(
      defineTool({
        name: mcpLocalToolPrefix(id) + 'read',
        description: 'Read the selected server',
        parameters: Type.Object({}),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          requiresApproval: 'never',
          costHint: {},
          deferLoading: false,
        },
        execute: async () => ({ content: [] }),
      }),
      { source: 'fixture', trust: 'builtin' },
    )
  for (const id of ids) {
    const tools = compositionTools(registry, { mcp: ['mcp/' + id] })
    const name = mcpLocalToolPrefix(id) + 'read'
    expect(tools.list().map((tool) => tool.name)).toEqual([name])
    expect(tools.size).toBe(1)
    expect(tools.resolve(name)).toBeDefined()
    expect(tools.snapshot(0).defs.map((tool) => tool.name)).toEqual([name])
    expect(tools.resolve(mcpLocalToolPrefix(ids.find((other) => other !== id)!) + 'read')).toBeUndefined()
  }
  expect(registry.size).toBe(ids.length)
})

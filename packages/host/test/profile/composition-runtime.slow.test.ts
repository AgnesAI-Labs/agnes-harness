import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import {
  bindMcpResourceServer,
  type McpConnection,
  mcpLocalToolPrefix,
  mcpPublicToolName,
  skillResourceIdAt,
} from '@agnes/base'
import { ToolRegistry } from '@agnes/core'
import { defineTool } from '@agnes/extension-api'
import { parsePackageBundles } from '@agnes/host-common/profile/composition'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import {
  CompositionSessionStore,
  readLiveCompositionSessions,
} from '@agnes/host-providers/profile/composition-state'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import { RuntimeSecurityStatus, SessionCapabilitySet, validateAgainst } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { expect, it, vi } from 'vitest'
import { assertHostPublication } from '../../src/runtime/lifecycle/host-facade.js'
import {
  compositionModuleAllowed,
  compositionSkillOwners,
  compositionSkills,
  compositionSurfaceAllowed,
  compositionToolGroups,
  compositionTools,
} from '../../src/runtime/profile/composition-visibility.js'
import {
  capabilityToolCatalog,
  resolveSessionCapabilities,
} from '../../src/runtime/profile/session-capabilities.js'
import { createTestHost } from '../../testkit/index.js'
import { pluginHost, pluginRow, pluginSourceWith, targetOf } from '../assemble/plugin-extension-fixture.js'

vi.mock('@agnes/host-infrastructure/adapters/process-identity-default', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'composition-test-worker' }),
}))

function bundleFixture() {
  const ids = ['acme/a', 'acme/b', 'acme/general']
  const sources = ids.map((vendor, index) => {
    const source = pluginSourceWith(
      [
        {
          exportName: 'plugin',
          rowId: 'ext:' + vendor,
          body: `agnes.registerTool(tool('fixture_${index}'))
${
  index === 0
    ? `ctx.loops.register('acme/a', {
  id: 'fixture.business', version: '1.0.0', capabilities: [],
  codec: { version: 1, encode: (state) => ({ codecVersion: 1, state }), decode: (checkpoint) => checkpoint.state },
  create: () => ({ step: async () => ({ outcome: 'idle' }), cancel() {}, dispose() {}, checkpoint: () => ({ codecVersion: 1, state: null }) }),
  resume: () => ({ step: async () => ({ outcome: 'idle' }), cancel() {}, dispose() {}, checkpoint: () => ({ codecVersion: 1, state: null }) }),
})`
    : ''
}`,
        },
      ],
      { vendor },
    )
    if (index > 1) return source
    const file = join(source.snapshot.directory, 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.agnes.bundles = {
      [index === 0 ? 'a' : 'b']:
        index === 0 ? { profile: { loop: { id: 'fixture.business', version: '1.0.0' } } } : {},
    }
    if (index === 0) {
      manifest.agnes.plugins[0].inject.push('loops')
      const entry = join(source.snapshot.directory, 'index.js')
      writeFileSync(
        entry,
        readFileSync(entry, 'utf8').replace("inject: ['extension']", "inject: ['extension', 'loops']"),
      )
    }
    writeFileSync(file, JSON.stringify(manifest))
    return {
      ...source,
      snapshot: {
        ...source.snapshot,
        treeIntegrity: hashDirectory(source.snapshot.directory, { exclude: [] }),
      },
    }
  })
  const options = {
    script: [],
    disableSessionTitle: true,
    // A live deployment starts with no bundles, then receives both through publication.
    runtimePluginSources: async () => sources,
  }
  const row = (vendor: string, disabled = false) =>
    createPluginRow({
      ...pluginRow('ext:' + vendor, 'plugin', disabled, { vendor }),
      snapshotDigest: `sha256-${'8'.repeat(64)}`,
      exportName: 'plugin',
      inject: vendor === 'acme/a' ? ['extension', 'loops'] : ['extension'],
    })
  return { ids, sources, options, row }
}

it('isolates bundle tools from default and other bundles while retaining general plugins', async () => {
  const { ids, sources, options, row } = bundleFixture()
  const fixture = await pluginHost(sources, options)
  const dataDir = fixture.dataDir
  const target = targetOf(ids.map((vendor) => row(vendor)))
  try {
    await fixture.host.applyRuntimeTarget(target)
    const normal = await fixture.host.createSession({ key: 'default-tools', cwd: dataDir })
    const a = await fixture.host.createSession({ key: 'bundle-a', cwd: dataDir, bundles: ['acme/a#a'] })
    const b = await fixture.host.createSession({ key: 'bundle-b', cwd: dataDir, bundles: ['acme/b#b'] })
    for (const [session, expected] of [
      [normal, ['fixture_2']],
      [a, ['fixture_0', 'fixture_2']],
      [b, ['fixture_1', 'fixture_2']],
    ] as const) {
      const tools = session.currentTools()
      expect(
        tools
          .list()
          .filter((tool) => tool.name.startsWith('fixture_'))
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(expected)
      expect(
        tools
          .snapshot(0)
          .defs.filter((tool) => tool.name.startsWith('fixture_'))
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(expected)
      for (let i = 0; i < 3; i++)
        expect(!!tools.resolve('fixture_' + i)).toBe(new Set<string>(expected).has('fixture_' + i))
    }
    expect(
      fixture.host.compositionSessions?.().find((session) => session.sessionKey === a.key)?.toolGroups,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageId: 'acme/a',
          reason: 'bundle',
          bundles: ['acme/a#a'],
          tools: ['fixture_0'],
        }),
      ]),
    )
    const manifestFile = join(sources[0]!.snapshot.directory, 'package.json')
    const manifestBytes = readFileSync(manifestFile, 'utf8')
    try {
      writeFileSync(manifestFile, '{}')
      await expect(fixture.host.createSession({ key: 'unverified-bundle', cwd: dataDir })).rejects.toThrow(
        'E_COMPOSITION_BUNDLE_INTEGRITY',
      )
      expect(a.currentTools().resolve('fixture_0')).toBeDefined()
    } finally {
      writeFileSync(manifestFile, manifestBytes)
    }
    await normal.close()
    await a.close()
    await b.close()
  } finally {
    await fixture.host.close()
  }
})

it('drains a disabled business bundle while existing sessions retain their code', async () => {
  const { ids, sources, options, row } = bundleFixture()
  const fixture = await pluginHost(sources, options)
  const dataDir = fixture.dataDir
  try {
    await fixture.host.applyRuntimeTarget(targetOf(ids.map((vendor) => row(vendor))))
    const normal = await fixture.host.createSession({ key: 'default-tools', cwd: dataDir })
    const a = await fixture.host.createSession({ key: 'bundle-a', cwd: dataDir, bundles: ['acme/a#a'] })
    expect(
      (await fixture.host.applyRuntimeTarget(targetOf(ids.map((vendor) => row(vendor, vendor === 'acme/a')))))
        .ok,
    ).toBe(true)
    expect(
      fixture.host.pluginGenerationStatus!().plugins.find((item) => item.id === 'acme/general'),
    ).toMatchObject({ state: 'active' })
    const disabled = targetOf(ids.map((vendor) => row(vendor, vendor !== 'acme/b')))
    const report = await fixture.host.applyRuntimeTarget(disabled)
    expect(report.ok, JSON.stringify(report)).toBe(true)
    expect(normal.currentTools().resolve('fixture_2')).toBeDefined()
    expect(a.loop).toEqual({ id: 'fixture.business', version: '1.0.0' })
    expect(a.currentTools().resolve('fixture_0')).toBeDefined()
    await expect(
      fixture.host.createSession({ key: 'disabled-business', cwd: dataDir, bundles: ['acme/a#a'] }),
    ).rejects.toThrow()
    await expect(fixture.host.migrateSessionGeneration!('bundle-a')).rejects.toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    expect(fixture.host.pluginGenerationStatus!().plugins.find((item) => item.id === 'acme/a')).toMatchObject(
      { state: 'draining' },
    )
    const fresh = await fixture.host.createSession({ key: 'after-disable', cwd: dataDir })
    expect(fresh.currentTools().resolve('fixture_2')).toBeUndefined()
    await fresh.close()
    await normal.close()
    await a.close()
  } finally {
    await fixture.host.close()
  }
})

it('retains a cold bundle pin after the live general plugin is disabled', async () => {
  const { ids, sources, options, row } = bundleFixture()
  let fixture = await pluginHost(sources, options)
  const dataDir = fixture.dataDir
  try {
    await fixture.host.applyRuntimeTarget(targetOf(ids.map((vendor) => row(vendor))))
    const a = await fixture.host.createSession({ key: 'bundle-a', cwd: dataDir, bundles: ['acme/a#a'] })
    const pin = a.pluginGenerationId
    const report = await fixture.host.applyRuntimeTarget(
      targetOf(ids.map((vendor) => row(vendor, vendor === 'acme/general'))),
    )
    expect(report.ok, JSON.stringify(report)).toBe(true)
    await a.close()
    await fixture.host.close()
    fixture = await pluginHost(sources, { ...options, dataDir })
    const reopened = await fixture.host.createSession({ key: 'bundle-a', cwd: dataDir })
    expect(reopened.pluginGenerationId).toBe(pin)
    expect(reopened.currentTools().resolve('fixture_0')).toBeDefined()
    expect(reopened.currentTools().resolve('fixture_1')).toBeUndefined()
    expect(reopened.currentTools().resolve('fixture_2')).toBeDefined()
    await reopened.close()
  } finally {
    await fixture.host.close()
  }
})

function presetCompositionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-compositions-'))
  let refuseWriter = false
  const options = {
    dataDir: root,
    script: [],
    disableSessionTitle: true,
    provider: (profile: import('@agnes/host-common/profile/types').ResolvedProfile) => {
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
  return {
    root,
    options,
    refuseWriter: (value: boolean) => {
      refuseWriter = value
    },
  }
}

it('isolates preset compositions and keeps session bundle choices immutable', async () => {
  const { root, options } = presetCompositionFixture()
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
    const beforeSkills = buildCompleteRuntimeTarget({
      rows: host.extensionRows.current().filter((row) => row.id === 'ext:agnes/skills'),
      resources: host.runtimeTargetSnapshot!().resource.resources,
    }).target
    await host.refreshSkillRow({
      list: () => [],
      read: () => ({ ok: false, code: 'NOT_FOUND' }),
      readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
    })
    expect(await host.applyRuntimeTarget(beforeSkills)).toMatchObject({ ok: true })
    const rows = await host.extensionRows.apply(host.extensionRows.current())
    expect(rows).toMatchObject({ ok: true })
    expect(host.compositionPublicationStatus?.()).toMatchObject({
      operation: 'extension-rows',
      ok: true,
      containers: [{ status: 'applied' }, { status: 'applied' }],
    })
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
    await reader.close()
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(1)
    await writer.close()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('publishes model changes per composition and reports a partial provider refusal', async () => {
  const { root, options, refuseWriter } = presetCompositionFixture()
  const { host } = await createTestHost(options)
  try {
    const reader = await host.createSession({ key: 'reader-session', preset: 'reader', cwd: root })
    const writer = await host.createSession({ key: 'writer-session', preset: 'writer', cwd: root })
    const observer = await host.createSession({
      key: 'observer-session',
      preset: 'observer',
      cwd: root,
      bundles: ['@fixture/session#reader'],
    })
    const next = structuredClone(host.profile)
    const route = next.provider.routes?.find((route) => route.route === 'gw')
    const first = route?.models?.[0]
    if (!route || !first) throw new Error('fixture route missing')
    route.models = [...(route.models ?? []), { ...first, id: 'live-model', name: 'live-model' }]
    await expect(host.applyModelProfile({ ...next, dataDir: join(root, 'other-backend') })).rejects.toThrow(
      'non-model configuration requires restart',
    )
    refuseWriter(true)
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
    refuseWriter(false)
    expect(await host.applyModelProfile(next)).toMatchObject({ ok: true })
    await writer.setModel({ slot: 'primary', route: route.route, model: 'live-model' })
    await reader.close()
    await writer.close()
    await observer.close()
  } finally {
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('restores and migrates pinned preset and bundle compositions after a cold reopen', async () => {
  const { root, options } = presetCompositionFixture()
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (await createTestHost(options)).host
    const reader = await host.createSession({ key: 'reader-session', preset: 'reader', cwd: root })
    const writer = await host.createSession({ key: 'writer-session', preset: 'writer', cwd: root })
    const observer = await host.createSession({
      key: 'observer-session',
      preset: 'observer',
      cwd: root,
      bundles: ['@fixture/session#reader'],
    })
    await observer.close()
    const profileDir = join(root, 'profiles', 'local-dev')
    const bindings = new CompositionSessionStore(profileDir)
    const generation = reader.pluginGenerationId
    await reader.close()
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(1)
    await writer.close()
    await host.close()
    host = (await createTestHost(options)).host
    const resumed = await host.createSession({ key: 'reader-session', cwd: root })
    expect(resumed.pluginGenerationId).toBe(generation)
    expect(resumed.currentTools().resolve('write')).toBeUndefined()
    expect(
      host
        .sessionCapabilities?.(resumed.key)
        .tools.filter((tool) => tool.enabled)
        .map((tool) => tool.id),
    ).toEqual(
      resumed
        .currentTools()
        .list()
        .map((tool) => tool.name),
    )
    expect(host.sessionCapabilities?.(resumed.key).codePin.generationId).toBe(generation)
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
    for (const name of [mcpLocalToolPrefix(id) + 'read', mcpPublicToolName(id, 'read')])
      registry.add(
        defineTool({
          name,
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
    const names = [name, mcpPublicToolName(id, 'read')]
    expect(tools.list().map((tool) => tool.name)).toEqual(names)
    expect(tools.size).toBe(2)
    expect(tools.resolve(names[1]!)).toBeDefined()
    expect(tools.resolve(name)).toBeDefined()
    expect(tools.snapshot(0).defs.map((tool) => tool.name)).toEqual([...names].sort())
    expect(tools.resolve(mcpLocalToolPrefix(ids.find((other) => other !== id)!) + 'read')).toBeUndefined()
  }
  const tree = {
    profile: 'local-dev',
    preset: 'full-access',
    bundles: [],
    selection: {},
    sources: {},
    rows: [],
    hash: `sha256-${'0'.repeat(64)}`,
  }
  // One status read must describe one authorized catalog, even if the next read changes selection.
  let selected = 'a.b'
  const live = compositionTools(registry, {}, undefined, () => {
    const current = selected
    selected = 'a_b'
    return resolveSessionCapabilities({
      selection: { mcp: [`mcp/${current}`] },
      installed: { tools: capabilityToolCatalog(registry) },
    })
  })
  for (const id of ['a.b', 'a_b'])
    expect(compositionToolGroups(live, tree)).toEqual([
      {
        packageId: 'fixture',
        reason: 'official-default',
        bundles: [],
        tools: [mcpLocalToolPrefix(id) + 'read', mcpPublicToolName(id, 'read')].sort(),
      },
    ])
  expect(registry.size).toBe(ids.length * 2)
})

it('retains a legacy session deployment when bundles are configured after its first boot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-legacy-composition-'))
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (
      await createTestHost({
        dataDir: root,
        script: [],
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
      })
    ).host
    const original = await host.createSession({ key: 'before-bundles', cwd: root })
    const generation = original.pluginGenerationId
    const loop = original.loop
    expect(new CompositionSessionStore(join(root, 'profiles', 'local-dev')).read(original.key)?.legacy).toBe(
      true,
    )
    await original.close()
    await host.close()
    host = (
      await createTestHost({
        dataDir: root,
        script: [],
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
        profileInputs: { user: { name: 'local-dev', composition: { tools: ['read'] } } },
      })
    ).host
    const resumed = await host.createSession({ key: 'before-bundles', cwd: root })
    expect(resumed.pluginGenerationId).toBe(generation)
    expect(resumed.loop).toEqual(loop)
    expect(resumed.currentTools().resolve('write')).toBeDefined()
    expect(host.sessionCapabilities?.(resumed.key).tools.find((tool) => tool.id === 'write')?.enabled).toBe(
      true,
    )
    await resumed.close()
    await host.releaseSessionGeneration?.(resumed.key)
    expect(new CompositionSessionStore(join(root, 'profiles', 'local-dev')).read(resumed.key)).toBeUndefined()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('opens a new composition from the published code after retiring a boot snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-composition-update-'))
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  const id = 'acme/composition-code'
  const source = (version: string): RuntimePluginSnapshot => {
    const directory = join(root, version)
    mkdirSync(directory)
    writeFileSync(join(directory, 'index.mjs'), version)
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: id,
        version,
        exports: './index.mjs',
        agnes: {
          plugins: [
            { apiRange: '^1.4.0', export: 'main', id: 'ext:composition-code', inject: ['extension'] },
          ],
        },
      }),
    )
    const integrity = hashDirectory(directory, { exclude: [] })
    return {
      snapshot: {
        profile: 'local-dev',
        packageId: id,
        version,
        snapshotId: integrity,
        integrity,
        treeIntegrity: integrity,
        capabilityHash: 'a'.repeat(64),
        directory,
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
  }
  const one = source('1.0.0'),
    two = source('2.0.0')
  let available = [one, two]
  try {
    const options: Parameters<typeof createTestHost>[0] = {
      dataDir: root,
      script: [],
      allowed: ['standard', 'observer'],
      presets: {
        observer: { name: 'observer', extends: 'standard', composition: { tools: ['code_version'] } },
      },
      profileInputs: {
        user: { name: 'local-dev', composition: {}, packages: [{ id, source: 'fixture' }] },
      },
      lock: {
        packages: Object.fromEntries([
          ...['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
            id,
            { version: '0.1.0', integrity: 'sha512-fixture', trust: 'builtin', enabled: true },
          ]),
          [
            id,
            {
              version: one.snapshot.version,
              integrity: one.snapshot.integrity,
              trust: 'trusted',
              enabled: true,
            },
          ],
        ]),
      },
      packageDirs: { [id]: one.snapshot.directory },
      runtimePluginSnapshots: [one],
      runtimePluginSources: async () => available,
      extensionLoader: {
        async import(file) {
          const version = readFileSync(file, 'utf8')
          return {
            main: {
              inject: ['extension'],
              apply(ctx: import('@agnes/cordis').Context) {
                ctx.extension().registerTool({
                  name: 'code_version',
                  description: version,
                  parameters: Type.Object({}),
                  meta: {
                    isReadOnly: true,
                    isDestructive: false,
                    isConcurrencySafe: true,
                    isOpenWorld: false,
                    replay: 'safe',
                    costHint: {},
                    deferLoading: false,
                    requiresApproval: 'never',
                  },
                  async execute() {
                    return { content: [{ type: 'text', text: version }] }
                  },
                })
              },
            },
          }
        },
      },
    }
    host = (await createTestHost(options)).host
    const old = await host.createSession({ key: 'old-code', cwd: root })
    const base = host.runtimeTargetSnapshot?.()
    if (!base) throw new Error('missing published target')
    await host.applyRuntimeTarget(
      buildCompleteRuntimeTarget({
        rows: [
          createPluginRow({
            id: 'ext:composition-code',
            plugin: `${id}@${two.snapshot.snapshotId}/main`,
            snapshotDigest: two.snapshot.integrity,
            exportName: 'main',
            entryRevision: two.snapshot.integrity,
            extrasRevision: 'none',
            mountRevision: 'host-ordinary-row:v1',
            inject: ['extension'],
          }),
        ],
        resources: base.resource.resources,
      }).target,
    )
    available = [two]
    rmSync(one.snapshot.directory, { recursive: true, force: true })
    const current = await host.createSession({ key: 'new-composition', preset: 'observer', cwd: root })
    expect(current.currentTools().resolve('code_version')?.description).toBe('2.0.0')
    expect(old.currentTools().resolve('code_version')?.description).toBe('1.0.0')
    const pin = old.pluginGenerationId
    await old.close()
    await current.close()
    await host.close()
    host = (
      await createTestHost({
        ...options,
        profileInputs: {
          user: { name: 'local-dev', composition: {}, packages: [{ id, source: 'fixture', enabled: false }] },
        },
        lock: {
          packages: {
            ...options.lock?.packages,
            [id]: {
              version: two.snapshot.version,
              integrity: two.snapshot.integrity,
              trust: 'trusted',
              enabled: false,
            },
          },
        },
        packageDirs: {},
        runtimePluginSnapshots: [],
      })
    ).host
    const reopened = await host.createSession({ key: old.key, cwd: root })
    expect(reopened.pluginGenerationId).toBe(pin)
    expect(reopened.currentTools().resolve('code_version')?.description).toBe('1.0.0')
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('uses one MCP server decision for discovery and shared resource invocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-capability-mcp-'))
  const requested: string[] = []
  const unbind = ['allowed', 'denied'].map((id) =>
    bindMcpResourceServer(
      id,
      {
        id,
        supportsResources: true,
        listResources: async () => {
          requested.push(id)
          return { resources: [{ name: id, uri: 'fixture://' + id }] }
        },
      } as McpConnection,
      { id, transport: 'stdio', cmd: ['fixture'], defer: false },
    ),
  )
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
    profileInputs: {
      user: { name: 'local-dev', composition: { mcp: ['mcp/allowed'], toolPolicy: { readOnly: true } } },
    },
    script: [
      ...['denied', 'allowed'].map((server) => [
        {
          type: 'toolcall_end' as const,
          via: 'native' as const,
          call: { toolUseId: '', name: 'list_mcp_resources', args: { server }, ordinal: 0 },
        },
        { type: 'done' as const, reason: 'toolUse' as const },
      ]),
      [{ type: 'text_delta', delta: 'done' }],
    ],
  })
  try {
    for (const id of ['allowed', 'denied'])
      host.kernel.resources.register(
        { id: 'mcp/' + id, kind: 'mcp', name: id, description: 'fixture' },
        { source: 'agnes/fixture', trust: 'builtin' },
      )
    const session = await host.createSession({ key: 'mcp-capabilities', cwd: root })
    const capabilities = host.sessionCapabilities!(session.key)
    expect(validateAgainst(SessionCapabilitySet, capabilities).ok).toBe(true)
    expect(capabilities.mcp.filter((item) => item.enabled).map((item) => item.id)).toEqual(['mcp/allowed'])
    expect(
      session
        .toolCatalog()
        .resources.filter((item) => item.kind === 'mcp')
        .map((item) => item.id),
    ).toEqual(['mcp/allowed'])
    await session.enqueue('next-turn', {
      actor: session.d.actor,
      content: [{ type: 'text', text: 'read resources' }],
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const results = JSON.stringify(
      (await session.scan({ type: 'tool/result', toSeq: session.lastSeq })).map((row) => row.data),
    )
    expect(results).toContain('Tool denied by the selected composition policy.')
    expect(results).toContain('fixture://allowed')
    expect(requested).toEqual(['allowed'])
    await session.close()
  } finally {
    for (const dispose of unbind) dispose()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

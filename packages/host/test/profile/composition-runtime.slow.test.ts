import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { bindMcpResourceServer, type McpConnection, mcpPublicToolName, skillResourceIdAt } from '@agnes/base'
import { ToolRegistry } from '@agnes/core'
import type { ToolContext } from '@agnes/extension-api'
import { compactionKind, loopKind } from '@agnes/extension-api'
import { parsePackageBundles } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile, RouteDecl } from '@agnes/host-common/profile/types'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import {
  CompositionSessionStore,
  readLiveCompositionSessions,
} from '@agnes/host-providers/profile/composition-state'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  emptyLock,
  hashDirectory,
  RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
  writeLock,
} from '@agnes/package-manager'
import { defineTool } from '@agnes/plugin-runtime'
import { createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import { RuntimeSecurityStatus, SessionCapabilitySet, validateAgainst } from '@agnes/protocol'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'
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
import {
  pluginHost,
  pluginRow,
  pluginSourceWith,
  scratch,
  targetOf,
} from '../assemble/plugin-extension-fixture.js'

vi.mock('@agnes/host-infrastructure/adapters/process-identity-default', () => ({
  defaultProcessIdentity: async () => ({ state: 'alive', startId: 'composition-test-worker' }),
}))

// Integration cases assemble and reopen several real composition Hosts. Their per-case budgets
// include Windows filesystem work; product startup, drain and recovery deadlines remain unchanged.

it('keeps a runtime Skill out of a session that disables its owning package', async () => {
  const vendor = 'acme/runtime-skill'
  const source = pluginSourceWith(
    [
      {
        exportName: 'plugin',
        rowId: 'ext:acme/runtime-skill',
        body: "ctx.skills.register({name:'runtime-review',description:'runtime review',body:'Enabled package instructions'})",
      },
    ],
    { vendor },
  )
  const manifestPath = join(source.snapshot.directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.agnes.plugins[0].inject.push('skills')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const entryPath = join(source.snapshot.directory, 'index.js')
  writeFileSync(
    entryPath,
    readFileSync(entryPath, 'utf8').replace(
      "inject: ['hooks', 'eventLog', 'self', 'tools']",
      "inject: ['hooks', 'eventLog', 'self', 'tools', 'skills']",
    ),
  )
  const installed = {
    ...source,
    snapshot: {
      ...source.snapshot,
      treeIntegrity: hashDirectory(source.snapshot.directory, { exclude: [] }),
    },
  }
  const registry = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const fixture = await pluginHost(installed, {
    skillResources: registry.snapshot(),
    skillContribution: createSkillCordisService(registry),
    allowed: ['standard', 'without-runtime'],
    presets: {
      'without-runtime': {
        name: 'without-runtime',
        extends: 'standard',
        composition: { packages: [{ id: vendor, source: 'fixture', enabled: false }] },
      },
    },
  })
  try {
    const row = createPluginRow({
      ...pluginRow('ext:acme/runtime-skill', 'plugin', false, { vendor }),
      snapshotDigest: source.snapshot.integrity,
      exportName: 'plugin',
      inject: ['hooks', 'eventLog', 'self', 'tools', 'skills'],
    })
    expect(await fixture.host.applyRuntimeTarget(targetOf([row]))).toMatchObject({ ok: true })
    const enabled = await fixture.host.createSession({ key: 'skill-enabled', cwd: fixture.dataDir })
    const disabled = await fixture.host.createSession({
      key: 'skill-disabled',
      cwd: fixture.dataDir,
      preset: 'without-runtime',
    })
    const read = async (session: typeof enabled) => {
      const tool = session.currentTools().resolve('skill_read')
      if (!tool) throw new Error('missing Skill read tool')
      return tool.execute({ name: 'runtime-review' }, {
        session: { key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot },
        signal: new AbortController().signal,
      } as ToolContext)
    }
    expect(await read(enabled)).not.toMatchObject({ isError: true })
    expect(await read(disabled)).toMatchObject({ isError: true })
    expect(fixture.host.runtimeSkillCandidates?.()).toMatchObject([
      { name: 'runtime-review', body: 'Enabled package instructions' },
    ])
    await enabled.close()
    await disabled.close()
  } finally {
    await fixture.host.close()
  }
}, 60_000) // Builds three isolated compositions; measures real Windows assembly, not a timer mock.

function bundleFixture() {
  const ids = ['acme/a', 'acme/b', 'acme/general']
  const sources = ids.map((vendor, index) => {
    const source = pluginSourceWith(
      [
        {
          exportName: 'plugin',
          rowId: 'ext:' + vendor,
          body: `ctx.tools.register(tool('fixture_${index}'))
${
  index === 0
    ? `ctx.providers.registerHost(loopKind, 'acme/a', {
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
        index === 0
          ? { profile: { providers: { loop: { provider: 'fixture.business', version: '1.0.0' } } } }
          : {},
    }
    if (index === 0) {
      manifest.agnes.plugins[0].inject.push('providers')
      const entry = join(source.snapshot.directory, 'index.js')
      writeFileSync(
        entry,
        "import { loopKind } from '@agnes/extension-api'\n" +
          readFileSync(entry, 'utf8').replace(
            "inject: ['hooks', 'eventLog', 'self', 'tools']",
            "inject: ['hooks', 'eventLog', 'self', 'tools', 'providers']",
          ),
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
    extensionLoader: createLoader({ cacheDir: scratch(), hostRoot: process.cwd(), agnesVersion: '0.0.0' }),
    // A live deployment starts with no bundles, then receives both through publication.
    runtimePluginSources: async () => sources,
  }
  const row = (vendor: string, disabled = false) =>
    createPluginRow({
      ...pluginRow('ext:' + vendor, 'plugin', disabled, { vendor }),
      snapshotDigest: `sha256-${'8'.repeat(64)}`,
      exportName: 'plugin',
      inject:
        vendor === 'acme/a'
          ? ['hooks', 'eventLog', 'self', 'tools', 'providers']
          : ['hooks', 'eventLog', 'self', 'tools'],
    })
  return { ids, sources, options, row }
}

it.each(['join', 'failure', 'close'] as const)(
  'handles %s during default prewarm without publishing a session',
  async (mode) => {
    const { sources, options } = bundleFixture()
    let hold = false
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let failed = false
    let preparedIds: string[] = []
    const fixture = await pluginHost(sources, {
      ...options,
      runtimePluginSources: async () => {
        if (hold) {
          entered()
          await gate
          if (mode === 'failure') throw new Error('synthetic prewarm source failure')
        }
        return sources
      },
      log: {
        info(message) {
          if (message.startsWith('Default composition prewarm ready'))
            preparedIds = fixture.host.pluginGenerationStatus!().generations.map(({ id }) => id)
        },
        warn(message) {
          if (message.startsWith('Default composition prewarm failed')) failed = true
        },
        debug() {},
        error() {},
      },
    })
    try {
      hold = true
      fixture.host.prewarmDefaultComposition?.()
      await started
      expect(fixture.host.kernel.sessions.size).toBe(0)
      if (mode === 'close') {
        const closing = fixture.host.close()
        release()
        await closing
        await expect(fixture.host.createSession({ key: 'closed', cwd: fixture.dataDir })).rejects.toThrow(
          'closed',
        )
      } else {
        const opening =
          mode === 'join' ? fixture.host.createSession({ key: 'joined', cwd: fixture.dataDir }) : undefined
        release()
        if (mode === 'failure') await vi.waitFor(() => expect(failed).toBe(true))
        hold = false
        const session = await (opening ?? fixture.host.createSession({ key: 'retry', cwd: fixture.dataDir }))
        if (mode === 'join') expect(preparedIds).toContain(session.pluginGenerationId)
        expect(session.key).toBe(mode === 'join' ? 'joined' : 'retry')
        await session.close()
      }
    } finally {
      hold = false
      release()
      await fixture.host.close()
    }
  },
  30_000,
)

it('releases an unused speculative default under the generation idle policy without periodic rewarming', async () => {
  const { ids, sources, options, row } = bundleFixture()
  let ready = false
  let disposed = 0
  const fixture = await pluginHost(sources, {
    ...options,
    limits: { 'worker.generation_idle_close_ms': 60_000 },
    onSeamClose: () => {
      disposed++
    },
    log: {
      debug() {},
      warn() {},
      error() {},
      info(message) {
        if (message.startsWith('Default composition prewarm ready')) ready = true
      },
    },
  })
  try {
    await fixture.host.applyRuntimeTarget(targetOf(ids.map((vendor) => row(vendor))))
    await vi.waitFor(() => expect(ready).toBe(true))
    const before = disposed
    await fixture.host.collectPluginGenerations?.()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_001)
    await fixture.host.collectPluginGenerations?.()
    expect(disposed).toBeGreaterThan(before)
    vi.useRealTimers()
    const collected = disposed
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(disposed).toBe(collected)
    const session = await fixture.host.createSession({ key: 'after-idle-prewarm', cwd: fixture.dataDir })
    expect(session.currentTools().resolve('fixture_2')).toBeDefined()
    await session.close()
  } finally {
    vi.useRealTimers()
    await fixture.host.close()
  }
}, 30_000)

it.each([false, true])(
  'isolates bundle tools from default and other bundles (boot snapshots=%s)',
  async (bootSnapshots) => {
    const { ids, sources, options, row } = bundleFixture()
    let ready = false
    const fixture = await pluginHost(sources, {
      ...options,
      log: {
        info: (message) => {
          if (message.startsWith('Default composition prewarm ready')) ready = true
        },
        debug() {},
        warn() {},
        error() {},
      },
      ...(bootSnapshots ? { runtimePluginSnapshots: sources } : {}),
    })
    const dataDir = fixture.dataDir
    const target = targetOf(ids.map((vendor) => row(vendor)))
    try {
      await fixture.host.applyRuntimeTarget(target)
      await vi.waitFor(() => expect(ready).toBe(true))
      const preparedGenerations = fixture.host.pluginGenerationStatus!()
        .generations.map(({ id }) => id)
        .sort()
      let normal = await fixture.host.createSession({ key: 'default-tools', cwd: dataDir })
      expect(
        fixture.host.pluginGenerationStatus!()
          .generations.map(({ id }) => id)
          .sort(),
      ).toEqual(preparedGenerations)
      await normal.close()
      ready = false
      fixture.host.prewarmDefaultComposition?.()
      await vi.waitFor(() => expect(ready).toBe(true))
      const archived = await new RuntimeGenerationSnapshotStore(
        join(dataDir, 'profiles', 'local-dev'),
      ).readAsync(normal.pluginGenerationId!)
      const source = archived.sources.find(({ snapshot }) => snapshot.packageId === ids[2])
      if (!source) throw new Error('fixture generation lacks the general plugin')
      const codeFile = join(source.snapshot.directory, 'index.js')
      const originalCode = readFileSync(codeFile, 'utf8')
      try {
        writeFileSync(codeFile, originalCode + '\n// synthetic archive tampering\n')
        const refusal = await fixture.host.createSession({ key: normal.key, cwd: dataDir }).then(
          async (session) => {
            await session.close()
            return 'unexpectedly admitted'
          },
          (error: unknown) => String(error),
        )
        expect(refusal).toMatch(/integrity|snapshot/i)
      } finally {
        writeFileSync(codeFile, originalCode)
      }
      normal = await fixture.host.createSession({ key: normal.key, cwd: dataDir })
      // A default composition uses the same declared-source vocabulary as its control container.
      if (bootSnapshots)
        expect((await fixture.host.applyRuntimeTarget(target)).publication?.containers).toHaveLength(1)
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
  },
  90_000,
)

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
}, 90_000)

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
}, 90_000)

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
      // This static fixture belongs to a builtin package, so live plugin publication retains it.
      bundleCatalog: parsePackageBundles('@agnes/ai', {
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
        providers: { compaction: { provider: 'fixture' } },
        composition: { tools: ['write'] },
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
              inject: ['providers'],
              provide: [],
              runtime: 'in-process' as const,
            },
            entry: normalizePluginExport({
              inject: ['providers'],
              apply(ctx) {
                ctx.providers.registerHost(compactionKind, '@agnes/host', {
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
      bundles: ['@agnes/ai#reader'],
    })
    expect(observer.currentTools().resolve('write')).toBeUndefined()
    const status = host.pluginGenerationStatus!()
    expect(status.generations.flatMap((generation) => generation.sessions ?? [])).toEqual(
      expect.arrayContaining([reader, writer, observer].map((session) => ({ key: session.key, open: true }))),
    )
    for (const generation of status.generations)
      expect(generation.openSessions).toBe(
        (generation.sessions ?? []).filter((session) => session.open).length,
      )
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
    expect(bindings.read(observer.key)?.tree.sessionBundles).toEqual(['@agnes/ai#reader'])
    expect(bindings.read(observer.key)?.tree.sources.tools).toEqual({
      layer: 'session',
      name: '@agnes/ai#reader',
    })
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(2)
    await reader.close()
    expect(await readLiveCompositionSessions(profileDir)).toHaveLength(1)
    await writer.close()
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

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
      bundles: ['@agnes/ai#reader'],
    })
    // Worker profiles arrive as JSON; object field order cannot prevent a model-only publication.
    const next = JSON.parse(JSON.stringify(host.profile), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ) as ResolvedProfile
    const route = next.provider.routes?.find((route: RouteDecl) => route.route === 'gw')
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
}, 90_000)

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
      bundles: ['@agnes/ai#reader'],
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
    const retainedIds = host.pluginGenerationStatus!().generations.map((entry) => entry.id)
    const resumed = await host.createSession({ key: 'reader-session', cwd: root })
    expect(resumed.pluginGenerationId).toBe(generation)
    // Cold admission restores retained code; it must not persist scratch/default generations.
    expect(
      host.pluginGenerationStatus!()
        .generations.map((entry) => entry.id)
        .sort(),
    ).toEqual(retainedIds.sort())
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
    // Restart reuses the durable composition head; only a real publication needs migration.
    expect(await host.migrateSessionGeneration?.(resumed.key)).toMatchObject({
      generationId: generation,
      changed: false,
    })
    const rows = host.extensionRows.current()
    expect(rows.some((row) => row.id === 'ext:agnes/refine')).toBe(true)
    expect(
      await host.applyRuntimeTarget(
        buildCompleteRuntimeTarget({
          rows: rows.filter((row) => row.id !== 'ext:agnes/refine'),
          resources: host.runtimeTargetSnapshot!().resource.resources,
        }).target,
      ),
    ).toMatchObject({ ok: true })
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
}, 180_000)

it('publishes a restarted worker’s delivered target on each composition’s earlier generation', async () => {
  const { root, options } = presetCompositionFixture()
  // Like the daemon's, this target names no Host-default rows, so it differs from every boot target.
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const generationsDir = join(root, 'profiles', 'local-dev', '.runtime-generations')
  const durable = () => ({
    generations: readdirSync(generationsDir)
      .filter((name) => /^[a-f0-9-]{36}$/.test(name))
      .sort(),
    heads: readdirSync(join(generationsDir, 'heads'))
      .sort()
      .map((name) => readFileSync(join(generationsDir, 'heads', name), 'utf8')),
  })
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (await createTestHost(options)).host
    await host.applyRuntimeTarget(delivered)
    // The writer preset selects another composition and profile, so it opens its own container.
    const writer = await host.createSession({ key: 'writer-session', preset: 'writer', cwd: root })
    const pinned = writer.pluginGenerationId
    await writer.close()
    await host.close()
    const before = durable()
    expect(before.heads).toHaveLength(2)
    host = (await createTestHost(options)).host
    await host.applyRuntimeTarget(delivered)
    const resumed = await host.createSession({ key: 'writer-session', cwd: root })
    expect(resumed.pluginGenerationId).toBe(pinned)
    await resumed.close()
    await host.close()
    expect(durable()).toEqual(before)
  } finally {
    await host?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)

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
  // A live catalog may refresh between reads; each returned list must use one catalog snapshot.
  const snapshot = listed
  const refreshing = compositionSkills(
    {
      ...input,
      list: () => {
        const current = input.list()
        listed = []
        return current
      },
    },
    { skills: ['read'] },
  )!
  expect(refreshing.list().map((skill) => skill.resourceId)).toEqual(['visible'])
  listed = snapshot

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
    for (const name of [mcpPublicToolName(id, 'read')])
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
    const name = mcpPublicToolName(id, 'read')
    const names = [name]
    expect(tools.list().map((tool) => tool.name)).toEqual(names)
    expect(tools.size).toBe(1)
    expect(tools.resolve(name)).toBeDefined()
    expect(tools.snapshot(0).defs.map((tool) => tool.name)).toEqual([...names].sort())
    expect(tools.resolve(mcpPublicToolName(ids.find((other) => other !== id)!, 'read'))).toBeUndefined()
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
        tools: [mcpPublicToolName(id, 'read')],
      },
    ])
  expect(registry.size).toBe(ids.length)
})

it('retains a legacy session deployment when bundles are configured after its first boot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-legacy-composition-'))
  expect(existsSync(join(root, 'profiles'))).toBe(false)
  let host: Awaited<ReturnType<typeof createTestHost>>['host'] | undefined
  try {
    host = (
      await createTestHost({
        dataDir: root,
        script: [],
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
      })
    ).host
    expect(existsSync(join(root, 'profiles'))).toBe(true)
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
}, 90_000)

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
          plugins: [{ apiRange: '^4.0.0', export: 'main', id: 'ext:composition-code', inject: ['tools'] }],
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
        capabilityHash: capabilityHash({ dependencies: {} }),
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
            {
              version: '0.1.0',
              source: { type: 'builtin', ref: 'builtin' },
              integrity: 'builtin:0.1.0',
              trust: 'builtin',
              enabled: true,
            },
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
              inject: ['tools'],
              apply(ctx: import('@agnes/cordis').Context) {
                ctx.tools.register({
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
            inject: ['tools'],
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
    // Installation trust is independent of source retention and desired enablement.
    const profileDir = join(root, 'profiles/local-dev')
    writeLock(profileDir, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      packages: {
        [id]: {
          version: two.snapshot.version,
          integrity: two.snapshot.integrity,
          source: { type: 'file', ref: 'file:fixture' },
          trust: 'trusted',
          license: 'MIT',
          dependencies: {},
          previous: null,
          state: { installed: new Date(0).toISOString(), trusted: new Date(0).toISOString(), enabled: false },
          trustDecision: {
            integrity: two.snapshot.integrity,
            capabilityHash: two.snapshot.capabilityHash,
            decidedAt: new Date(0).toISOString(),
          },
        },
      },
    })
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
}, 90_000)

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
      // MCP resource tools load on demand: discovery first, then the same composition policy.
      [
        {
          type: 'toolcall_end' as const,
          via: 'native' as const,
          call: { toolUseId: '', name: 'tool_describe', args: { name: 'list_mcp_resources' }, ordinal: 0 },
        },
        { type: 'done' as const, reason: 'toolUse' as const },
      ],
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
}, 90_000)

it('reclaims idle composition containers while preserving cold bindings', async () => {
  const root = scratch()
  const names = Array.from({ length: 8 }, (_, index) => `idle-${index}`)
  let created = 0
  let disposed = 0
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    limits: { 'worker.generation_idle_close_ms': 0 },
    allowed: ['standard', ...names],
    presets: Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          name,
          extends: 'standard',
          composition: { tools: ['read', 'write', 'ls'].filter((_, bit) => index & (1 << bit)) },
        },
      ]),
    ),
    profileInputs: {
      user: {
        name: 'local-dev',
        composition: {},
        presets: { default: 'standard', allowed: ['standard', ...names] },
      },
    },
    provider: (profile) => {
      created++
      return new ScriptedProvider({
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
        scripts: [],
      })
    },
    onSeamClose: () => {
      disposed++
    },
  })
  try {
    const baseline = created - disposed
    const sessions = []
    for (const name of names) sessions.push(await host.createSession({ key: name, cwd: root, preset: name }))
    const generation = host.sessionGeneration?.(names[0]!)
    const peak = created - disposed
    for (const session of sessions.slice(1)) await session.close()
    await host.collectPluginGenerations?.()
    expect(created - disposed).toBe(baseline + 1)
    await sessions[0]?.close()
    await vi.waitFor(() => expect(created - disposed).toBe(baseline), { timeout: 5000 })
    const retained = created - disposed
    console.info(
      'EXECGUARD_COMPOSITION_MEASURE',
      JSON.stringify({ compositions: names.length, baseline, peak, retained, disposed }),
    )
    expect(retained).toBe(baseline)
    expect(host.sessionGeneration?.(names[0]!)).toBe(generation)
    const beforeReopen = created
    expect(host.kernel.get(names[0]!)).toBeUndefined()
    expect(() => host.kernel.session(names[0]!, {} as never)).toThrow('E_COMPOSITION_NOT_LIVE')
    expect(() => host.memory(root, names[0]!)).toThrow('E_COMPOSITION_NOT_LIVE')
    expect(
      (await host.readSessionRows(names[0]!, { limit: 3 })).some((row) => row.type === 'session/start'),
    ).toBe(true)
    const reopened = await host.createSession({ key: names[0]!, cwd: root })
    expect(created).toBeGreaterThan(beforeReopen)
    expect(reopened.pluginGenerationId).toBe(generation)
    expect(reopened.currentTools().list()).toHaveLength(0)
    await reopened.close()
  } finally {
    await host.close()
  }
  expect(disposed).toBe(created)
}, 90_000)

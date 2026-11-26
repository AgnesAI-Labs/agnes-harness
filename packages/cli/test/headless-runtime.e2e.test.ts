import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientModuleRegistry } from '@agnes/daemon/packages'
import { buildCompleteRuntimeTarget, dataDir } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import {
  createPackageManager,
  localPluginRoots,
  localWorkspaceTrustHash,
  RuntimeGenerationSnapshotStore,
  readLock,
} from '@agnes/package-manager'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootHeadless } from '../src/boot/headless.js'

// Exercise production discovery/loader wiring with testkit's lightweight builtin backends.
vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createHost: async (
    profile: import('@agnes/host').ResolvedProfile,
    options: import('@agnes/host').HostOptions,
  ) =>
    (
      await createTestHost({
        dataDir: profile.dataDir,
        script: [],
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: profile.name,
            dataDir: profile.dataDir,
            packages: profile.packages.map(({ id, source, config }) => ({
              id,
              source,
              ...(config ? { config } : {}),
            })),
          },
          ...(profile.composition ? { adminComposition: profile.composition } : {}),
        },
        lock: {
          packages: Object.fromEntries(
            profile.packages.map((pkg) => [
              pkg.id,
              {
                version: pkg.version,
                source: { type: pkg.trust === 'builtin' ? 'builtin' : 'file', ref: pkg.source },
                integrity: pkg.integrity,
                trust: pkg.trust,
                enabled: pkg.enabled,
              },
            ]),
          ),
        },
        packageDirs: Object.fromEntries(options.packageDirs ?? []),
        ...(options.skillContribution ? { skillContribution: options.skillContribution } : {}),
        ...(options.skillResources ? { skillResources: options.skillResources } : {}),
        ...(options.runtimePluginSnapshots ? { runtimePluginSnapshots: options.runtimePluginSnapshots } : {}),
        ...(options.runtimePluginSources ? { runtimePluginSources: options.runtimePluginSources } : {}),
        ...(options.extensionLoader ? { extensionLoader: options.extensionLoader } : {}),
      })
    ).host,
}))

// Transpiles plugins from source and takes the durable package lock repeatedly: 4-5 s on a Linux
// CI runner against Vitest's 5 s default there, so the case keeps its own budget.
it('reloads zero-build workspace plugins without granting their panels native Web execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-headless-runtime-'))
  const home = join(root, 'home')
  const plugins = localPluginRoots(home, root).workspace
  const panel = join(plugins, 'student-panel')
  const loop = join(plugins, 'student-loop')
  await mkdir(join(panel, 'client'), { recursive: true })
  await mkdir(loop, { recursive: true })
  for (const [template, directory, name] of [
    ['tool-with-panel', panel, 'student-panel'],
    ['loop', loop, 'student-loop'],
  ] as const) {
    const replace = (value: string) =>
      value
        .replaceAll('__PACKAGE_NAME__', name)
        .replaceAll('__SKILL_NAME__', name)
        .replaceAll('__TOOL_NAME__', 'student_echo')
        .replaceAll('__SERVICE_NAME__', name.replaceAll('-', ''))
    const manifest = JSON.parse(
      replace(
        await readFile(new URL(`../../../templates/${template}/package.json`, import.meta.url), 'utf8'),
      ),
    )
    manifest.exports = './plugin.ts'
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await writeFile(
      join(directory, 'plugin.ts'),
      replace(
        await readFile(new URL(`../../../templates/${template}/src/index.ts`, import.meta.url), 'utf8'),
      ),
    )
  }
  const descriptor = JSON.parse(
    (
      await readFile(
        new URL('../../../templates/tool-with-panel/client/agnes.client.json', import.meta.url),
        'utf8',
      )
    )
      .replaceAll('__PACKAGE_NAME__', 'student-panel')
      .replaceAll('__SKILL_NAME__', 'student-panel')
      .replaceAll('__SERVICE_NAME__', 'studentpanel'),
  )
  // The template now defaults to a profile page; this fixture exercises retained session panels.
  delete descriptor.client.homeEntries
  descriptor.client.lifetime = 'session'
  descriptor.client.slots = ['workbench.panel']
  await writeFile(join(panel, 'client/agnes.client.json'), JSON.stringify(descriptor))
  await writeFile(join(panel, 'client/index.js'), 'export const panelVersion = "original"')
  const bundle = join(root, 'bundle.json')
  await writeFile(
    bundle,
    JSON.stringify({ profile: { providers: { loop: { provider: 'agnes.default', version: '1.0.0' } } } }),
  )
  let boot: Awaited<ReturnType<typeof bootHeadless>> | undefined
  let registry: ReturnType<typeof createClientModuleRegistry> | undefined
  try {
    const start = () =>
      bootHeadless(
        { bundle, args: parseArgs(['-p']), signal: new AbortController().signal },
        {
          home,
          cwd: root,
          env: { HOME: root },
          agnesVersion: '0.1.0',
          log: () => {},
        },
      )
    boot = await start()
    const initialHost = boot.host
    if (!initialHost) throw new Error('Embedded Host missing')
    const profileDir = join(home, 'profiles/local-dev')
    const roots = localPluginRoots(home, root)
    const manager = createPackageManager({
      dataDir: dataDir(home),
      agnesVersion: '0.1.0',
      localPlugins: roots,
    })
    const reviewWorkspace = () =>
      manager.trustWorkspace(
        profileDir,
        root,
        localWorkspaceTrustHash(roots, readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.1.0' })),
      )
    expect(initialHost.kernel.loops.catalog()).not.toContainEqual(
      expect.objectContaining({ id: 'student-loop' }),
    )
    await reviewWorkspace()
    await boot.close()
    boot = await start()
    const host = boot.host
    if (!host?.runtimeTargetSnapshot || !host.reloadPlugin) throw new Error('Embedded Host APIs missing')
    const targetSnapshot = host.runtimeTargetSnapshot.bind(host)
    expect(host.profile.dataDir).not.toBe(join(home, 'data'))
    expect(host.kernel.loops.catalog()).toContainEqual(
      expect.objectContaining({ id: 'student-loop', version: '0.1.0' }),
    )
    await boot.client.workspace.add(root)
    const first = await boot.client.session.new({ cwd: root, sessionKey: 'panel-first' })
    expect((await first.tools()).tools).toContainEqual(expect.objectContaining({ name: 'student_echo' }))
    const loopSession = await boot.client.session.new({
      cwd: root,
      sessionKey: 'loop-session',
      loop: { id: 'student-loop', version: '0.1.0' },
    })
    expect(host.kernel.get(loopSession.id)?.loop).toEqual({ id: 'student-loop', version: '0.1.0' })
    const readInventory = () => manager.inventory(join(home, 'profiles/local-dev'))
    registry = createClientModuleRegistry({
      snapshotDirectory: () => join(root, 'browser'),
      runtimeArtifacts: () => ({
        lastGood: buildCompleteRuntimeTarget({
          rows: targetSnapshot().tree.rows,
          resources: targetSnapshot().resource.resources,
        }).artifact,
      }),
    })
    const input = {
      profile: 'local-dev',
      profileDirectory: join(host.profile.dataDir, 'profiles/local-dev'),
      inventory: await readInventory(),
      refreshInventory: readInventory,
      actual: async (id: string) => {
        const pkg = (await readInventory()).packages.find((pkg) => pkg.id === id)
        if (!pkg) throw new Error('Package not found')
        return { actual: 'running' as const, actualIntegrity: pkg.entry.integrity }
      },
    }
    const profileRoster = await registry.list(input)
    const roster = await registry.list({ ...input, sessionId: first.id })
    await writeFile(join(panel, 'client/index.js'), 'export const panelVersion = "reloaded"')
    await expect(host.reloadPlugin('student-panel', panel)).rejects.toThrow('E_GENERATION_UNTRUSTED')
    await manager.refreshLocalPlugins(join(home, 'profiles/local-dev'))
    await reviewWorkspace()
    await host.reloadPlugin('student-panel', panel)
    const second = await boot.client.session.new({ cwd: root, sessionKey: 'panel-second' })
    const updatedInput = { ...input, inventory: await readInventory() }
    const next = await registry.list({ ...updatedInput, sessionId: second.id })
    const store = new RuntimeGenerationSnapshotStore(input.profileDirectory)
    expect(store.session(second.id)?.generationId).not.toBe(store.session(first.id)?.generationId)
    expect(store.session(first.id)).toBeDefined()
    for (const projection of [profileRoster, roster, next]) {
      expect(projection.rows).not.toContainEqual(
        expect.objectContaining({ packageId: 'student-panel', phase: 'ready' }),
      )
      expect(projection.modules).not.toContainEqual(expect.objectContaining({ packageId: 'student-panel' }))
    }
    for (const [session, installed] of [
      [first, input.inventory],
      [second, updatedInput.inventory],
    ] as const) {
      const panel = installed.packages.find((row) => row.id === 'student-panel')
      if (!panel) throw new Error('workspace panel not installed')
      const loaderPath = `/student-panel/${encodeURIComponent(panel.entry.integrity)}/client/index.js`
      const generation = store.session(session.id)?.generationId
      expect(generation).toBeDefined()
      for (const prefix of ['/plugins', `/plugins/generations/${generation}`]) {
        expect(
          await registry.read({
            ...updatedInput,
            purpose: 'document',
            path: `${prefix}${loaderPath}`,
          }),
        ).toEqual({ found: false })
      }
    }
  } finally {
    registry?.close()
    await boot?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

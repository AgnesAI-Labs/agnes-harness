import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientModuleRegistry } from '@agnes/daemon/packages'
import { buildCompleteRuntimeTarget } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import {
  createPackageManager,
  localPluginRoots,
  RuntimeGenerationSnapshotStore,
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
            packages: profile.packages.map(({ id, source }) => ({ id, source })),
            ...(profile.loop ? { loop: profile.loop } : {}),
            ...(profile.composition ? { composition: profile.composition } : {}),
          },
        },
        lock: {
          packages: Object.fromEntries(
            profile.packages.map((pkg) => [
              pkg.id,
              {
                version: pkg.version,
                integrity: pkg.integrity,
                trust: pkg.trust,
                enabled: pkg.enabled,
              },
            ]),
          ),
        },
        packageDirs: Object.fromEntries(options.packageDirs ?? []),
        ...(options.runtimePluginSnapshots ? { runtimePluginSnapshots: options.runtimePluginSnapshots } : {}),
        ...(options.runtimePluginSources ? { runtimePluginSources: options.runtimePluginSources } : {}),
        ...(options.extensionLoader ? { extensionLoader: options.extensionLoader } : {}),
      })
    ).host,
}))

it('loads zero-build loops and panels into isolated headless sessions and publishes reloaded panel assets', async () => {
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
      value.replaceAll('__PACKAGE_NAME__', name).replaceAll('__TOOL_NAME__', 'student_echo')
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
  await writeFile(
    join(panel, 'client/agnes.client.json'),
    await readFile(new URL('../../../templates/tool-with-panel/client/agnes.client.json', import.meta.url)),
  )
  await writeFile(join(panel, 'client/index.js'), 'export const panelVersion = "original"')
  const bundle = join(root, 'bundle.json')
  await writeFile(bundle, JSON.stringify({ profile: { loop: { id: 'default', version: '1.0.0' } } }))
  let boot: Awaited<ReturnType<typeof bootHeadless>> | undefined
  let registry: ReturnType<typeof createClientModuleRegistry> | undefined
  try {
    boot = await bootHeadless(
      { bundle, args: parseArgs(['-p']), signal: new AbortController().signal },
      {
        home,
        cwd: root,
        env: { HOME: root },
        agnesVersion: '0.0.0',
        log: () => {},
      },
    )
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
    const manager = createPackageManager({ dataDir: join(home, 'data'), agnesVersion: '0.0.0' })
    const inventory = await manager.inventory(join(home, 'profiles/local-dev'))
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
      inventory,
      refreshInventory: async () => inventory,
      actual: async (id: string) => {
        const pkg = inventory.packages.find((pkg) => pkg.id === id)
        if (!pkg) throw new Error('Package not found')
        return { actual: 'running' as const, actualIntegrity: pkg.entry.integrity }
      },
    }
    expect((await registry.list(input)).rows).toContainEqual(
      expect.objectContaining({ packageId: 'student-panel', phase: 'ready' }),
    )
    const roster = await registry.list({ ...input, sessionId: first.id })
    expect(roster.rows).toContainEqual(
      expect.objectContaining({ packageId: 'student-panel', phase: 'ready' }),
    )
    await writeFile(join(panel, 'client/index.js'), 'export const panelVersion = "reloaded"')
    await host.reloadPlugin('student-panel', panel)
    const second = await boot.client.session.new({ cwd: root, sessionKey: 'panel-second' })
    const next = await registry.list({ ...input, sessionId: second.id })
    const store = new RuntimeGenerationSnapshotStore(input.profileDirectory)
    expect(store.session(second.id)?.generationId).not.toBe(store.session(first.id)?.generationId)
    expect(store.session(first.id)).toBeDefined()
    expect(next.rows).toContainEqual(expect.objectContaining({ packageId: 'student-panel', phase: 'ready' }))
    const original = roster.modules[0],
      updated = next.modules[0]
    if (!original || !updated) throw new Error('Panel module missing')
    expect(updated.entryUrl).not.toBe(original.entryUrl)
    const asset = await registry.read({ ...input, path: updated.entryUrl })
    expect(asset.found).toBe(true)
    if (asset.found) expect(Buffer.from(asset.base64, 'base64').toString()).toContain('reloaded')
    const oldAsset = await registry.read({ ...input, path: original.entryUrl })
    expect(oldAsset.found).toBe(true)
    if (oldAsset.found) expect(Buffer.from(oldAsset.base64, 'base64').toString()).toContain('original')
  } finally {
    registry?.close()
    await boot?.close()
    await rm(root, { recursive: true, force: true })
  }
})

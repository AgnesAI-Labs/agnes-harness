import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostOptions, Prompter, ResolvedProfile } from '@agnes/host'
import { parseAgnesPluginEntries } from '@agnes/package-manager'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

const createHost = vi.hoisted(() =>
  vi.fn<(profile: ResolvedProfile, opts: HostOptions) => Promise<{ close(): Promise<void> }>>(async () => ({
    close: async () => undefined,
  })),
)

vi.mock('@agnes/host', async () => {
  const actual = await vi.importActual<typeof import('@agnes/host')>('@agnes/host')
  return { ...actual, createHost }
})

import {
  AGNES_BASE_PLUGIN_DECLARATIONS,
  createPackagedHost,
  type packagedPackages,
  readPackagedBuiltinExports,
} from './packaged-host.js'

const temporary: string[] = []

afterEach(async () => {
  createHost.mockClear()
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const prompter: Prompter = { ask: async () => 'allowed-once' }

async function packagedHome(): Promise<{ home: string; profile: ResolvedProfile; entryFile: string }> {
  const home = await mkdtemp(join(tmpdir(), 'agnes-packaged-host-'))
  temporary.push(home)
  await mkdir(join(home, 'cache'), { recursive: true })
  await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true })
  const profile = {
    name: 'local-dev',
    dataDir: home,
    cacheDir: join(home, 'cache'),
    packages: [],
  } as unknown as ResolvedProfile
  return { home, profile, entryFile: join(home, 'worker.mjs') }
}

describe('packaged host wiring', () => {
  it('keeps package directories compatible with the Host assembly contract', () => {
    type PackageDirectories = ReturnType<typeof packagedPackages>['packageDirs']

    expectTypeOf<PackageDirectories>().toEqualTypeOf<Map<string, string>>()
  })

  it('keeps the packaged base plugin declarations equal to package.json normalization', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../base/package.json', import.meta.url)), 'utf8'),
    ) as { agnes?: { plugins?: unknown } }

    expect(AGNES_BASE_PLUGIN_DECLARATIONS).toEqual(
      parseAgnesPluginEntries('@agnes/base', packageJson.agnes?.plugins),
    )
  })

  it('discovers all eight base seam plugins in a packaged worker', async () => {
    const module = readPackagedBuiltinExports('@agnes/base', 'worker.mjs', await import('@agnes/base'))

    expect(module.plugins?.map(({ declaration }) => declaration)).toEqual(AGNES_BASE_PLUGIN_DECLARATIONS)
    expect(module.plugins).toHaveLength(8)
    expect(module.plugins?.every(({ entry }) => typeof entry.prepared === 'object')).toBe(true)
  })

  it('does not synthesize plugin declarations for packaged ai or code modules', async () => {
    const [aiExports, codeExports] = await Promise.all([import('@agnes/ai'), import('@agnes/code')])
    const ai = readPackagedBuiltinExports('@agnes/ai', 'worker.mjs', aiExports)
    const code = readPackagedBuiltinExports('@agnes/code', 'worker.mjs', codeExports)

    expect(ai.plugins).toBeUndefined()
    expect(code.plugins).toBeUndefined()
  })

  it('forwards the bootstrapped Skill runtime to createHost without recreating it', async () => {
    const { home, profile, entryFile } = await packagedHome()
    const skillResources: NonNullable<HostOptions['skillResources']> = {
      list: () => [
        {
          kind: 'skill',
          resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
          name: 'chinese-teacher',
          description: 'Teach Chinese poetry',
          revision: 'b'.repeat(64),
          sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'c'.repeat(64) },
          priority: 500,
          resolution: { winner: true, shadowed: [] },
          trust: 'trusted',
          desired: 'enabled',
          actual: 'ready',
          stale: false,
        },
      ],
      read: () => ({ ok: true, content: 'authorized body' }),
      readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
    }
    const skillInstall: NonNullable<HostOptions['skillInstall']> = async () => ({
      proposalId: 'fixture',
      state: 'prepared',
    })
    await createPackagedHost(profile, prompter, {
      home,
      cwd: home,
      entryFile,
      skillResources,
      skillInstall,
    })
    expect(createHost).toHaveBeenCalledOnce()
    const options = createHost.mock.calls[0]?.[1]
    expect(options?.skillResources).toBe(skillResources)
    expect(options?.skillInstall).toBe(skillInstall)
  })

  it('assembles a packaged Host when no Skill runtime is present', async () => {
    const { home, profile, entryFile } = await packagedHome()
    await createPackagedHost(profile, prompter, { home, cwd: home, entryFile })
    expect(createHost).toHaveBeenCalledOnce()
    const options = createHost.mock.calls[0]?.[1]
    expect(options).not.toHaveProperty('skillResources')
  })

  it('forwards the verified ordinary-plugin snapshot selection without rebuilding it', async () => {
    const { home, profile, entryFile } = await packagedHome()
    const runtimePluginSnapshots: NonNullable<HostOptions['runtimePluginSnapshots']> = [
      {
        generation: 12,
        trusted: true,
        snapshot: {
          snapshotId: `sha256-${'1'.repeat(64)}`,
          profile: 'local-dev',
          packageId: '@acme/ordinary-plugin',
          version: '1.0.0',
          integrity: `sha256-${'2'.repeat(64)}`,
          treeIntegrity: `sha256-${'3'.repeat(64)}`,
          capabilityHash: 'capability',
          directory: join(home, 'immutable-snapshot'),
          contributions: [],
        },
      },
    ]
    const managedExtensionPackageIds = ['@acme/ordinary-plugin']
    await createPackagedHost(profile, prompter, {
      home,
      cwd: home,
      entryFile,
      runtimePluginSnapshots,
      managedExtensionPackageIds,
    })
    const options = createHost.mock.calls[0]?.[1]
    expect(options?.runtimePluginSnapshots).toBe(runtimePluginSnapshots)
    expect(options?.managedExtensionPackageIds).toBe(managedExtensionPackageIds)
  })

  it('forwards bootstrap Skill resources from the packaged worker entry', () => {
    const source = readFileSync(fileURLToPath(new URL('./worker-entry.ts', import.meta.url)), 'utf8')
    expect(source).toContain('buildHost: (profile, prompter, resources)')
    expect(source).toContain('...resources')
    expect(source).toContain('process.env.AGNES_WORKER_ROOT')
    expect(source).toContain("process.env.AGNES_WORKER_KIND === 'probe'")
    expect(source).toContain('runRuntimeTargetProbeExecutable()')
    expect(source).not.toContain('process.env.AGNES_CWD')
  })

  // The daemon hands its workers AGH_HOME, not AGNES_HOME. A worker entry that read the legacy
  // variable itself would miss it and fall back to the profile's dataDir, looking for installed
  // packages under <dataDir>/profiles instead of <home>/profiles. Read as source, like the test
  // above: importing the entry starts a worker.
  it('resolves the packaged worker home the same way every other process does', () => {
    const source = readFileSync(fileURLToPath(new URL('./worker-entry.ts', import.meta.url)), 'utf8')
    expect(source).toContain('home: agnesHome(process.env)')
    expect(source).not.toContain('process.env.AGNES_HOME')
    expect(source).not.toContain('process.env.AGH_HOME')
  })
})

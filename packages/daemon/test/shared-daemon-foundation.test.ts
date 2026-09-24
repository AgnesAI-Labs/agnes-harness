import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatform, isHostError, readConfigurationProfileInputs, resolveProfile } from '@agnes/host'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireDaemonOfflineMaintenance,
  acquireDaemonStartup,
  canonicalPath,
  DaemonDiscoveryError,
  DaemonStartupBusyError,
  publishDaemonDiscovery,
  readDaemonDiscovery,
  readDaemonWebCredential,
  removeDaemonDiscovery,
  resolveDaemonScope,
  runDaemonControl,
} from '../src/index.js'
import { acquireDaemonMutationLock } from '../src/supervisor/mutation-lock.js'
import { acquireOwnerLock } from '../src/supervisor/owner-lock.js'

const roots: string[] = []
async function makePublic(file: string): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [file, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
    })
    expect(hasPrivateDaclSync(file)).toBe(false)
  } else await chmod(file, 0o644)
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

describe('shared daemon scope', () => {
  it('applies explicit, environment and default precedence and excludes cwd from identity', async () => {
    const home = await root('agnes-scope-home-')
    const workspace = await root('agnes-scope-work-')
    const otherWorkspace = await root('agnes-scope-other-')
    const fromEnvironment = await resolveDaemonScope({
      env: { AGH_HOME: home, AGNES_PROFILE: 'local-dev', HOME: '/ignored' },
      workspace,
      dataDir: join(home, 'state'),
    })
    const fromAnotherCwd = await resolveDaemonScope({
      env: { AGH_HOME: home, AGNES_PROFILE: 'local-dev', HOME: '/ignored' },
      workspace: otherWorkspace,
      dataDir: join(home, 'state'),
    })
    expect(fromEnvironment.home).toBe(await canonicalPath(home))
    expect(fromEnvironment.profile).toBe('local-dev')
    expect(fromEnvironment.dataDir).toBe(await canonicalPath(join(home, 'state')))
    expect(fromAnotherCwd.scopeID).toBe(fromEnvironment.scopeID)

    const explicit = await resolveDaemonScope({
      env: { AGH_HOME: '/wrong', AGNES_PROFILE: 'enterprise', HOME: '/wrong-home' },
      home,
      profile: 'local-dev',
      workspace,
      dataDir: join(home, 'explicit'),
    })
    expect(explicit.scopeID).not.toBe(fromEnvironment.scopeID)
    expect(explicit.profileDir).toBe(join(await canonicalPath(home), 'profiles', 'local-dev'))
  })

  it('reads the Host profile layer and canonicalizes symlinked ancestors', async () => {
    const home = await root('agnes-scope-profile-')
    const workspace = await root('agnes-scope-workspace-')
    const alias = await root('agnes-scope-alias-')
    const osHome = await root('agnes-os-home-')
    await mkdir(join(home, 'profiles', 'enterprise'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'enterprise', 'profile.yaml'),
      'name: enterprise\ndataDir: ~/profile-data\ncacheDir: ~/cache\n',
    )
    await symlink(home, join(alias, 'home-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const scope = await resolveDaemonScope({
      env: { HOME: osHome },
      home: join(alias, 'home-link'),
      profile: 'enterprise',
      workspace,
    })
    expect(scope.home).toBe(await canonicalPath(home))
    expect(scope.dataDir).toBe(await canonicalPath(join(osHome, 'profile-data')))
    expect(scope.profileDir).toBe(join(scope.home, 'profiles', 'enterprise'))
  })

  it('rejects a corrupt package lock by default and only derives recovery scope when explicitly enabled', async () => {
    const home = await root('agnes-scope-corrupt-lock-')
    const workspace = await root('agnes-scope-corrupt-workspace-')
    const lock = join(home, 'profiles', 'local-dev', 'agnes-lock.json')
    await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true })
    await writeFile(lock, '{ corrupt-lock')
    await expect(resolveDaemonScope({ home, workspace, profile: 'local-dev' })).rejects.toMatchObject({
      code: 'E_LOCK_MISMATCH',
    })
    const recovered = await resolveDaemonScope({
      home,
      workspace,
      profile: 'local-dev',
      allowPackageRecovery: true,
    })
    expect(recovered.profileDir).toBe(join(await canonicalPath(home), 'profiles', 'local-dev'))
    expect(await readFile(lock, 'utf8')).toBe('{ corrupt-lock')
  })

  // The actual bug this pair of packages used to have: daemon's own default (home/data) and Host's
  // own default, taken independently for the same home the way `agnes doctor` or a plain `bootLocal`
  // run would, used to land in two different directories with nothing to say so. Naming the
  // equality here, rather than trusting that fixing one side fixed both.
  it('computes the exact same default dataDir as Host resolves independently for the same home', async () => {
    const home = await root('agnes-scope-equal-data-')
    const workspace = await root('agnes-scope-equal-work-')
    const scope = await resolveDaemonScope({ home, workspace, profile: 'local-dev' })

    const inputs = await readConfigurationProfileInputs({
      home,
      cwd: workspace,
      profile: 'local-dev',
      agnesVersion: '0.0.0',
    })
    const platform = createPlatform()
    await platform.probe({ root: workspace })
    const hostProfile = await resolveProfile(inputs, {
      platform: platform.snapshot(),
      agnesVersion: '0.0.0',
      now: new Date().toISOString(),
      // The same value bootLocal passes: an unconfigured profile's default is meant to sit under
      // whichever home the caller names, not under whatever the OS account's home happens to be.
      homeDir: await canonicalPath(home),
    })

    expect(scope.dataDir).toBe(await canonicalPath(hostProfile.dataDir))
    expect(scope.dataDir).toBe(join(await canonicalPath(home), 'data'))
  })

  it.each(['AGH_HOME', 'AGNES_HOME'])(
    'refuses a relative %s from the environment instead of resolving it against process.cwd()',
    async (variable) => {
      const workspace = await root('agnes-scope-relative-home-')
      const error = await resolveDaemonScope({
        // HOME is a temp dir so a regression that ignores the variable cannot reach the real ~/.agh.
        env: { [variable]: 'relative/agnes', HOME: workspace },
        workspace,
      }).catch((e: unknown) => e)
      expect(isHostError(error, 'E_HOME_INVALID')).toBe(true)
      expect((error as Error).message).toContain(`${variable} must be`)
      expect((error as Error).message).toContain('relative/agnes')
    },
  )

  it.each([
    { set: 'only AGH_HOME', env: (a: string, _b: string) => ({ AGH_HOME: a }), winner: 'a' },
    { set: 'only the legacy AGNES_HOME', env: (_a: string, b: string) => ({ AGNES_HOME: b }), winner: 'b' },
    {
      set: 'both set, where AGH_HOME wins',
      env: (a: string, b: string) => ({ AGH_HOME: a, AGNES_HOME: b }),
      winner: 'a',
    },
  ])('resolves the home from the environment with $set', async ({ env, winner }) => {
    const a = await root('agh-scope-env-a-')
    const b = await root('agh-scope-env-b-')
    const workspace = await root('agh-scope-env-work-')
    const osHome = await root('agh-scope-env-os-')
    const scope = await resolveDaemonScope({
      env: { ...env(a, b), HOME: osHome },
      workspace,
      profile: 'local-dev',
      dataDir: join(workspace, 'state'),
    })
    expect(scope.home).toBe(await canonicalPath(winner === 'a' ? a : b))
  })

  it('defaults the home to <HOME>/.agh when neither AGH_HOME nor AGNES_HOME is set', async () => {
    const osHome = await root('agh-scope-default-os-')
    const workspace = await root('agh-scope-default-work-')
    const scope = await resolveDaemonScope({
      env: { HOME: osHome },
      workspace,
      profile: 'local-dev',
      dataDir: join(workspace, 'state'),
    })
    expect(scope.home).toBe(join(await canonicalPath(osHome), '.agh'))
    expect(scope.profileDir).toBe(join(await canonicalPath(osHome), '.agh', 'profiles', 'local-dev'))
  })
})

describe('generation-bound discovery and Web credential', () => {
  it('publishes only validated nonsecret endpoint data and reads the private token separately', async () => {
    const dataDir = await root('agnes-discovery-')
    const workspace = await root('agnes-discovery-work-')
    const scope = await resolveDaemonScope({ home: dataDir, workspace, profile: 'local-dev', dataDir })
    const processIdentity = async () => ({ state: 'alive' as const, startId: 'foundation-test' })
    const lock = await acquireOwnerLock(dataDir, {
      socketPath: join(dataDir, 'daemon', 'agnesd.sock'),
      processIdentity,
    })
    try {
      const descriptor = await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: lock.owner.socketPath,
        profileHash: 'sha256-profile',
        web: {
          url: 'ws://127.0.0.1:43111/',
          origin: 'http://127.0.0.1:4177',
          token: 'a'.repeat(48),
        },
      })
      expect(descriptor.profileHash).toBe('sha256-profile')
      const raw = await readFile(scope.discoveryPath, 'utf8')
      if (process.platform === 'win32') {
        expect(hasPrivateDaclSync(scope.discoveryPath)).toBe(true)
        expect(hasPrivateDaclSync(scope.webCredentialPath)).toBe(true)
      }
      expect(raw).not.toContain('a'.repeat(48))
      expect(await readDaemonDiscovery(scope, { processIdentity })).toEqual(descriptor)
      expect(await readDaemonWebCredential(scope, { processIdentity })).toBe('a'.repeat(48))
      for (const contents of [Buffer.from([0xff]), Buffer.alloc(65537, 32)]) {
        await writeFile(scope.discoveryPath, contents)
        await expect(readDaemonDiscovery(scope, { processIdentity })).rejects.toBeInstanceOf(
          DaemonDiscoveryError,
        )
        await writeFile(scope.discoveryPath, raw)
      }
      if (process.platform === 'win32') {
        const alias = join(dataDir, 'discovery-hardlink')
        await link(scope.discoveryPath, alias)
        try {
          await expect(readDaemonDiscovery(scope, { processIdentity })).rejects.toBeInstanceOf(
            DaemonDiscoveryError,
          )
        } finally {
          await unlink(alias)
        }
      }
      await expect(
        readDaemonDiscovery(scope, {
          processIdentity,
          expectedWeb: { url: 'ws://127.0.0.1:43112/', origin: 'http://127.0.0.1:4177' },
        }),
      ).rejects.toBeInstanceOf(DaemonDiscoveryError)
      await makePublic(scope.webCredentialPath)
      await expect(readDaemonWebCredential(scope, { processIdentity })).rejects.toBeInstanceOf(
        DaemonDiscoveryError,
      )
      await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: lock.owner.socketPath,
        profileHash: 'sha256-profile',
        web: {
          url: 'ws://127.0.0.1:43111/',
          origin: 'http://127.0.0.1:4177',
          token: 'a'.repeat(48),
        },
      })
      const credential = JSON.parse(await readFile(scope.webCredentialPath, 'utf8')) as Record<
        string,
        unknown
      >
      await writeFile(scope.webCredentialPath, JSON.stringify({ ...credential, token: 123 }))
      await expect(readDaemonWebCredential(scope, { processIdentity })).rejects.toBeInstanceOf(
        DaemonDiscoveryError,
      )
      await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: lock.owner.socketPath,
        profileHash: 'sha256-profile',
      })
      await expect(
        readDaemonDiscovery(scope, {
          processIdentity,
          expectedWeb: { url: 'ws://127.0.0.1:43111/', origin: 'http://127.0.0.1:4177' },
        }),
      ).rejects.toBeInstanceOf(DaemonDiscoveryError)
      const current = JSON.parse(await readFile(scope.discoveryPath, 'utf8')) as Record<string, unknown>
      await writeFile(scope.discoveryPath, JSON.stringify({ ...current, capabilities: ['unix', 'bogus'] }))
      await expect(readDaemonDiscovery(scope, { processIdentity })).rejects.toBeInstanceOf(
        DaemonDiscoveryError,
      )
    } finally {
      await lock.release()
    }
  })

  it('treats a proven dead/reused owner as absent but refuses unknown identity', async () => {
    const dataDir = await root('agnes-discovery-identity-')
    const scope = await resolveDaemonScope({ home: dataDir, profile: 'local-dev', dataDir })
    const lock = await acquireOwnerLock(dataDir, {
      socketPath: join(dataDir, 'daemon', 'agnesd.sock'),
      processIdentity: async () => ({ state: 'alive' as const, startId: 'identity-test' }),
    })
    await publishDaemonDiscovery(scope, {
      owner: lock.owner,
      socketPath: lock.owner.socketPath,
      profileHash: 'sha256-profile',
    })
    await expect(
      readDaemonDiscovery(scope, { processIdentity: async () => ({ state: 'dead' as const }) }),
    ).resolves.toBeNull()
    await expect(
      readDaemonDiscovery(scope, {
        processIdentity: async () => ({ state: 'unknown' as const, reason: 'EPERM' }),
      }),
    ).rejects.toThrow('identity is unavailable')
    await lock.release()

    // A newly acquired owner may briefly see the previous generation's descriptor before it
    // publishes its own ready record. That stale file must not block crash recovery.
    const replacement = await acquireOwnerLock(dataDir, {
      socketPath: join(dataDir, 'daemon', 'agnesd.sock'),
      processIdentity: async () => ({ state: 'alive' as const, startId: 'identity-test' }),
    })
    await expect(
      readDaemonDiscovery(scope, {
        processIdentity: async () => ({ state: 'alive' as const, startId: 'identity-test' }),
      }),
    ).resolves.toBeNull()
    await replacement.release()
  })
})

describe('startup coordination', () => {
  it('has a recognizable busy failure and an idempotent release', async () => {
    const dataDir = await root('agnes-startup-lock-')
    const scope = await resolveDaemonScope({ home: dataDir, profile: 'local-dev', dataDir })
    const first = acquireDaemonStartup(scope)
    expect(() => acquireDaemonStartup(scope)).toThrow(DaemonStartupBusyError)
    first.release()
    expect(() => first.release()).not.toThrow()
    const second = acquireDaemonStartup(scope)
    second.release()
  })

  it('holds both launcher and daemon-owner locks for offline maintenance', async () => {
    const dataDir = await root('agnes-offline-maintenance-lock-')
    const scope = await resolveDaemonScope({ home: dataDir, profile: 'local-dev', dataDir })
    const maintenance = acquireDaemonOfflineMaintenance(scope)
    expect(() => acquireDaemonStartup(scope)).toThrow(DaemonStartupBusyError)
    expect(() => acquireDaemonMutationLock(dataDir)).toThrow('lock is held')
    maintenance.release()
    expect(() => maintenance.release()).not.toThrow()

    const daemonOwner = acquireDaemonMutationLock(dataDir)
    expect(() => acquireDaemonOfflineMaintenance(scope)).toThrow('lock is held')
    daemonOwner.release()
    const startup = acquireDaemonStartup(scope)
    startup.release()
  })
})

describe('generation-bound discovery cleanup', () => {
  it('preserves malformed or wrong-mode records until ownership can be proven', async () => {
    const dataDir = await root('agnes-discovery-cleanup-')
    const scope = await resolveDaemonScope({ home: dataDir, profile: 'local-dev', dataDir })
    const lock = await acquireOwnerLock(dataDir, {
      socketPath: join(dataDir, 'daemon', 'agnesd.sock'),
      processIdentity: async () => ({ state: 'alive' as const, startId: 'cleanup-test' }),
    })
    try {
      await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: lock.owner.socketPath,
        profileHash: 'sha256-cleanup',
      })
      await writeFile(scope.discoveryPath, '{malformed')
      await removeDaemonDiscovery(scope, lock.owner.generation)
      await expect(readFile(scope.discoveryPath, 'utf8')).resolves.toBe('{malformed')

      await publishDaemonDiscovery(scope, {
        owner: lock.owner,
        socketPath: lock.owner.socketPath,
        profileHash: 'sha256-cleanup',
        web: {
          url: 'ws://127.0.0.1:43113/',
          origin: 'http://127.0.0.1:4177',
          token: 'b'.repeat(48),
        },
      })
      await makePublic(scope.discoveryPath)
      await removeDaemonDiscovery(scope, lock.owner.generation)
      await expect(readFile(scope.discoveryPath, 'utf8')).resolves.toContain('agnesd-discovery')
      await expect(readFile(scope.webCredentialPath, 'utf8')).resolves.toContain('agnesd-web-credential')
    } finally {
      await lock.release()
    }
  })
})

describe('maintenance target resolution', () => {
  it('addresses an explicit data directory without parsing an unrelated malformed profile', async () => {
    const home = await root('agnes-control-home-')
    const dataDir = await root('agnes-control-data-')
    await mkdir(join(home, 'profiles', 'local-dev'), { recursive: true })
    await writeFile(join(home, 'profiles', 'local-dev', 'profile.yaml'), 'broken: [yaml')
    const status = async () => ({ running: false })
    const output: string[] = []
    await expect(
      runDaemonControl(
        { command: 'status', profile: 'local-dev', dataDir },
        { env: { AGH_HOME: home }, status, write: (text) => output.push(text) },
      ),
    ).resolves.toBe(1)
    expect(output).toEqual(['{"running":false}\n'])
  })

  it('refuses maintenance for a profile or home that conflicts with a live discovery record', async () => {
    const home = await root('agnes-control-scope-home-')
    const otherHome = await root('agnes-control-scope-other-home-')
    const dataDir = await root('agnes-control-scope-data-')
    const processIdentity = async () => ({ state: 'alive' as const, startId: 'control-scope-test' })
    const ownerLock = await acquireOwnerLock(dataDir, {
      socketPath: join(dataDir, 'daemon', 'agnesd.sock'),
      processIdentity,
    })
    try {
      const selected = await resolveDaemonScope({ home, profile: 'local-dev', dataDir })
      await publishDaemonDiscovery(selected, {
        owner: ownerLock.owner,
        socketPath: ownerLock.owner.socketPath,
        profileHash: 'sha256-control-scope',
      })
      const stop = vi.fn(async () => 'stopped' as const)
      const status = vi.fn(async () => ({ running: true, owner: ownerLock.owner }))
      await expect(
        runDaemonControl(
          { command: 'stop', home, profile: 'enterprise', dataDir },
          { stop, processIdentity },
        ),
      ).rejects.toThrow(/discovery does not match/)
      await expect(
        runDaemonControl(
          { command: 'status', home: otherHome, profile: 'local-dev', dataDir },
          { status, processIdentity },
        ),
      ).rejects.toThrow(/discovery does not match/)
      expect(stop).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    } finally {
      await ownerLock.release()
    }
  })
})

import { execFileSync } from 'node:child_process'

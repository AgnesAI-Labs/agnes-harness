import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { resolveDaemonScope, runAgnesd } from '@agnes/daemon'
import {
  PACKAGE_ADMIN_ALL_PERMISSIONS,
  type PackageAdminService,
  scopedPackageProfileDirectory,
} from '@agnes/daemon/packages'
import type { NodeClient } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { main } from '../src/bin.js'
import { runPackageCommand } from '../src/commands/package.js'
import type { ParsedArgs } from '../src/types.js'

// Deep Bug Hunt M-14. Oracles (independent of package.ts/packages-pins.ts/resources.ts):
//  - the connection a command runs on belongs to one profile scope: bootDefault reports it as
//    Booted.profileName (the shared daemon's resolved scope), and a request naming any other profile
//    is refused by that daemon;
//  - inputs.test.ts:70 "--profile beats AGNES_PROFILE beats local-dev", which the stubbed boot below
//    applies the same way boot/local.ts and boot/connect.ts do;
//  - daemon resolveDaemonScope: options.profile ?? env.AGNES_PROFILE ?? 'local-dev';
//  - scopedPackageProfileDirectory: a request profile other than the scope profile is CAPABILITY_DENIED.
// Tests assert the correct behaviour; a failure reproduces the defect.

// bin.ts dispatch is exercised through main() with bootDefault stubbed: it records the profile each
// connection was booted for and every profile a request then named.
const seen = vi.hoisted(() => ({ booted: [] as string[], sent: [] as Array<[string, string]> }))
vi.mock('../src/boot/default.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/boot/default.js')>()
  const { profileNameFrom } = await import('../src/boot/inputs.js')
  const record =
    <T>(method: string, result: T) =>
    async (params: { profile: string }) => {
      seen.sent.push([method, params.profile])
      return result
    }
  return {
    ...actual,
    bootDefault: vi.fn(async (p: ParsedArgs, deps: { env: NodeJS.ProcessEnv }) => {
      const profileName = profileNameFrom(p, deps.env)
      seen.booted.push(profileName)
      return {
        client: {
          clientId: async () => 'cli-client',
          packages: {
            list: record('packages.list', { packages: [] }),
            pins: { inspect: record('packages.pins.inspect', { orphans: [] }) },
          },
          resources: { list: record('resources.list', { items: [] }) },
          mcp: { servers: { list: record('mcp.servers.list', { items: [] }) } },
        },
        profileName,
        resolvedProfileHash: null,
        bootMs: 0,
        form: 'local' as const,
        close: async () => undefined,
      }
    }),
  }
})

const tmp: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  seen.booted.length = 0
  seen.sent.length = 0
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dbh-m14-'))
  tmp.push(d)
  return d
}

async function run(argv: string[], env: NodeJS.ProcessEnv) {
  const home = scratch()
  const stderr = new PassThrough()
  let errors = ''
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  const code = await main(argv, {
    env: { AGH_HOME: home, ...env },
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout: new PassThrough(),
    stderr,
    cwd: home,
    agnesVersion: '0',
  })
  return { code, errors, booted: [...seen.booted], sent: [...seen.sent] }
}

describe('dbh M-14: a command names the profile its connection was booted for', () => {
  it('control: an explicit --profile reaches packages.list when the command is called directly', async () => {
    const listed: Array<{ profile: string }> = []
    const client = {
      clientId: async () => 'cli-client',
      packages: {
        list: async (params: { profile: string }) => {
          listed.push(params)
          return { packages: [] }
        },
      },
    } as unknown as NodeClient
    await runPackageCommand(parseArgs(['package', 'status', '--profile', 'enterprise']), client, {
      write: () => undefined,
      confirm: async () => false,
    })
    expect(listed).toEqual([{ profile: 'enterprise' }])
  })

  it('[preserve] with neither --profile nor AGNES_PROFILE every command stays on local-dev', async () => {
    for (const argv of [
      ['package', 'status'],
      ['packages', 'pins', 'inspect'],
      ['resources', 'list'],
    ]) {
      const r = await run(argv, {})
      expect(r, argv.join(' ')).toMatchObject({
        code: 0,
        booted: ['local-dev'],
        sent: [[expect.any(String), 'local-dev']],
      })
      seen.booted.length = 0
      seen.sent.length = 0
    }
  })

  it('[control] an explicit --profile boots and sends the same profile', async () => {
    const pkg = await run(['package', 'status', '--profile', 'enterprise'], {})
    expect(pkg).toMatchObject({ code: 0, booted: ['enterprise'], sent: [['packages.list', 'enterprise']] })
    seen.booted.length = 0
    seen.sent.length = 0
    const res = await run(['resources', 'list', '--profile', 'enterprise'], {})
    expect(res).toMatchObject({ code: 0, booted: ['enterprise'], sent: [['resources.list', 'enterprise']] })
  })

  it.each([
    [['package', 'status'], 'packages.list'],
    [['packages', 'pins', 'inspect'], 'packages.pins.inspect'],
    [['resources', 'list'], 'resources.list'],
    [['mcp', 'list'], 'mcp.servers.list'],
  ])('[M-14] `agnes %s` under AGNES_PROFILE=enterprise sends the booted profile', async (argv, method) => {
    const r = await run(argv, { AGNES_PROFILE: 'enterprise' })
    expect({ booted: r.booted, sent: r.sent, code: r.code }, r.errors).toEqual({
      booted: ['enterprise'],
      sent: [[method, 'enterprise']],
      code: 0,
    })
  })

  it('[M-14] the profile `agnes package status` sends is accepted by the daemon scope of the same environment', async () => {
    const home = scratch()
    const env = { AGNES_PROFILE: 'enterprise', AGH_HOME: home, HOME: home }
    const scope = await resolveDaemonScope({ env, cwd: home })
    // Fact about the daemon side: the scope is the environment's profile.
    expect(scope.profile).toBe('enterprise')
    const resolver = scopedPackageProfileDirectory({
      profile: scope.profile,
      profileDir: scope.profileDir,
      profilesRoot: join(scope.home, 'profiles'),
    })
    // Control: the scope's own profile is accepted.
    await expect(resolver(scope.profile)).resolves.toContain(join('profiles', 'enterprise'))

    const r = await run(['package', 'status'], { AGNES_PROFILE: 'enterprise' })
    const sent = r.sent[0]?.[1] as string
    const outcome = await Promise.resolve(resolver(sent)).then(
      () => 'accepted',
      (e: { data?: { code?: string } }) => `rejected:${e.data?.code}`,
    )
    expect({ sent, outcome }).toEqual({ sent: 'enterprise', outcome: 'accepted' })
  })
})

describe('dbh M-14 (second source): daemon composition via runAgnesd with the real PackageAdmin', () => {
  it('a daemon started for AGNES_PROFILE=enterprise serves `agnes package status` without CAPABILITY_DENIED', async () => {
    const root = scratch()
    vi.stubEnv('AGNES_PROFILE', 'enterprise')
    vi.stubEnv('AGH_HOME', root)
    let packageAdmin: PackageAdminService | undefined
    await runAgnesd(
      { home: root, workspace: root, dataDir: join(root, 'daemon-data') },
      {
        startProduction: async (options) => {
          packageAdmin = options.packageAdmin?.service
          return {
            socketPath: join(root, 'daemon-data', 'daemon', 'test.sock'),
            owner: { pid: process.pid, generation: 1 },
            reclaimNow: async () => undefined,
            evictIdleNow: async () => undefined,
            close: async () => undefined,
          } as never
        },
        publishDiscovery: (async () => undefined) as never,
      },
    )
    if (!packageAdmin) throw new Error('PackageAdmin was not composed')
    const authority = {
      audience: 'admin' as const,
      principalId: 'unix:test-owner',
      clientId: 'cli-client',
      permissions: PACKAGE_ADMIN_ALL_PERMISSIONS,
    }
    const call = (params: unknown) =>
      (packageAdmin as PackageAdminService).call('_agnes/v1/packages.list', params, authority).then(
        (r) => ({ ok: r }),
        (e: { data?: { code?: string } }) => ({ code: e.data?.code }),
      )
    // Control: the daemon's own scope profile is served.
    expect(await call({ profile: 'enterprise' })).toMatchObject({ ok: { packages: expect.any(Array) } })

    const r = await run(['package', 'status'], { AGNES_PROFILE: 'enterprise' })
    const sent = { profile: r.sent[0]?.[1] }
    const outcome = await call(sent)
    expect({ sent, outcome }).toMatchObject({
      sent: { profile: 'enterprise' },
      outcome: { ok: { packages: expect.any(Array) } },
    })
  })
})

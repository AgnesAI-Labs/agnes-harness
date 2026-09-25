import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import {
  ecosystem as baseEcosystem,
  seams as baseSeams,
  SHELL_SENTINEL,
  sandboxWorkspaceProbe,
} from '@agnes/base'
import { type SandboxSeam, WORKSPACE_HOOK_SANDBOX } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import {
  type ExtensionAPI,
  type ExtensionManifest,
  type HookContext,
  type HookEvent,
  type HookHandler,
  unavailableProjections,
} from '@agnes/extension-api'
import type { ModelRecord, RouteDecl } from '@agnes/protocol'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import type { FencedFs } from '../src/adapters/fs.js'
import { openAdapters, toSeamAdapters } from '../src/adapters/index.js'
import {
  MemoryPackageLoader,
  type PackageModule,
  type SeamFactory,
  type SeamInitContext,
} from '../src/assemble/packages.js'
import { trustedHookCommands } from '../src/assemble/trusted-hooks.js'
import { type AssembleDeps, type Assembled, assemble } from '../src/assemble.js'
import { createMemoryAudit } from '../src/audit.js'
import { HostError } from '../src/errors.js'
import { readConfigurationProfileInputs } from '../src/profile/inputs.js'
import { resolveProfile } from '../src/profile/resolve.js'
import type { ProfileInputs } from '../src/profile/types.js'
import { createSession } from '../src/session.js'
import {
  type SessionWorkspaceRuntime,
  SessionWorkspaceRuntimeTable,
} from '../src/session-workspace-runtime.js'
import { type WorkspaceBinding, WorkspaceBindingAuthority } from '../src/workspace-authority.js'
import { attachTestSeamPlugins } from '../testkit/cordis-seams.js'

/**
 * Task 14, Steps 2-3: the L0 sandbox policy is enforced by the real host FsOps, and every process
 * creation passes the no-backend gate. Nothing here is a fake file system or a fake spawner: the
 * policy is compiled by the real @agnes/base sandbox seam, bound by the real assembly, and held
 * against real directories on a real volume; the exec cases use marker files, so a spawn that
 * happened leaves evidence a refused one cannot fake.
 */

const MODEL: ModelRecord = {
  id: 'm1',
  name: 'm1',
  api: 'openai',
  route: 'gw',
  baseUrl: 'https://gw.example/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const ROUTE: RouteDecl = { route: 'gw', api: 'openai', baseUrl: 'https://gw.example/v1', models: [MODEL] }
const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
] as const

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

// Symlink sub-cases run only where the volume permits them; every other assertion runs everywhere.
const canSymlink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-l0-linkcheck-'))
  try {
    symlinkSync('.', join(d, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})()

const code = (e: unknown): string | undefined =>
  e instanceof HostError ? e.code : ((e as { code?: unknown })?.code as string | undefined)

const bytes = new TextEncoder().encode('x')

type Fixture = {
  init: SeamInitContext
  a: Assembled
  profile: Awaited<ReturnType<typeof resolveProfile>>
  seam: SandboxSeam
  fs: FencedFs
  binding: WorkspaceBinding
  runtime: SessionWorkspaceRuntime
  table: SessionWorkspaceRuntimeTable
  workspace: string
  dataDir: string
  homeDir: string
}

/**
 * A full real assembly whose sandbox seam is @agnes/base's own factory, driven by a preset that
 * names the extra allow root and the configured deny. Everything else is the standard fake-seam
 * stand-in, because nothing here is about those seams.
 */
async function assembleWithSandbox(opts: {
  sandboxPreset?: Record<string, unknown>
  extraAllow?: string[]
  /** Built against the fixture's dataDir, since configured denies often name paths under it. */
  configuredDeny?: (dataDir: string) => string[]
  sandboxFactory?: SeamFactory
  shellRequest?: string
  hooksDeployment?: 'workspace' | 'data' | 'no-grant' | 'wrong-digest' | 'wrong-source' | 'wrong-root'
  workspace?: string
}): Promise<Fixture> {
  const workspace = opts.workspace ?? scratch('agnes-l0-ws-')
  const dataDir = scratch('agnes-l0-data-')
  const homeDir = scratch('agnes-l0-home-')
  let init: SeamInitContext | undefined
  let commandHooks:
    | {
        trustedUnconfined: Array<{
          source: 'data' | 'workspace'
          configDigest: string
          workspaceRoot: string
        }>
      }
    | undefined
  if (opts.hooksDeployment) {
    const marker = join(workspace, 'assembly-hook.json').replaceAll("'", "''")
    const command = `[IO.File]::WriteAllText('${marker}', [Console]::In.ReadToEnd()); [Console]::Error.Write('装载链拒绝'); exit 2`
    const bytes = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } })
    const source = opts.hooksDeployment === 'data' ? 'data' : 'workspace'
    const directory = source === 'data' ? dataDir : join(workspace, '.agh')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'hooks.json'), bytes)
    if (opts.hooksDeployment !== 'no-grant')
      commandHooks = {
        trustedUnconfined: [
          {
            source: opts.hooksDeployment === 'wrong-source' ? 'data' : source,
            configDigest: `sha256-${createHash('sha256')
              .update(opts.hooksDeployment === 'wrong-digest' ? `${bytes} ` : bytes)
              .digest('hex')}`,
            workspaceRoot: opts.hooksDeployment === 'wrong-root' ? dataDir : workspace,
          },
        ],
      }
  }
  const fakes = fakeSeams()
  const sandboxFactory =
    opts.sandboxFactory ??
    (baseSeams as { sandbox?: SeamFactory }).sandbox ??
    ((() => Promise.reject(new Error('no sandbox seam delivered'))) as SeamFactory)
  const mods: Record<string, PackageModule> = {
    '@agnes/base': {
      id: '@agnes/base',
      sandboxWorkspaceProbe,
      ...(opts.hooksDeployment
        ? {
            ecosystem: { 'agnes/hooks-runner': baseEcosystem['agnes/hooks-runner'] },
            embeddedExtensions: [
              JSON.parse(
                readFileSync(
                  new URL('../../base/extensions/hooks-runner/agnes.extension.json', import.meta.url),
                  'utf8',
                ),
              ) as ExtensionManifest,
            ],
          }
        : {}),
      seams: {
        ...Object.fromEntries(SEAM_KEYS.filter((n) => n !== 'sandbox').map((n) => [n, async () => fakes[n]])),
        sandbox: async (context) => {
          init = context
          return sandboxFactory(context)
        },
      },
      operations: {},
      presets: {
        base: {
          name: 'base',
          sandbox: {
            level: 'L0',
            ...(opts.extraAllow ? { extra_paths: opts.extraAllow } : {}),
            ...(opts.configuredDeny ? { deny_paths: opts.configuredDeny(dataDir) } : {}),
            ...(opts.sandboxPreset ?? {}),
          },
        },
      },
    },
    '@agnes/code': {
      id: '@agnes/code',
      presets: { standard: { name: 'standard', extends: 'base', disclosure: 'standard' } },
      operations: {},
    },
    '@agnes/ai': { id: '@agnes/ai' },
  }
  attachTestSeamPlugins(mods['@agnes/base'] as PackageModule)
  const inputs: ProfileInputs = {
    builtin: 'local-dev',
    lock: {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
          id,
          { version: '0.1.0', integrity: 'sha512-x', trust: 'builtin' as const, enabled: true },
        ]),
      ),
    },
    user: {
      name: 'local-dev',
      ...(commandHooks ? { commandHooks } : {}),
      provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
    },
  }
  if (opts.hooksDeployment) {
    const directory = join(homeDir, 'profiles', 'local-dev')
    mkdirSync(directory, { recursive: true })
    // JSON is valid YAML and avoids adding another serializer to the test fixture.
    writeFileSync(join(directory, 'profile.yaml'), JSON.stringify(inputs.user))
  }
  const loadedInputs = opts.hooksDeployment
    ? await readConfigurationProfileInputs({
        home: homeDir,
        cwd: workspace,
        profile: 'local-dev',
        agnesVersion: '0.1.0',
        ...(inputs.lock ? { lock: inputs.lock } : {}),
      })
    : inputs
  const profile = await resolveProfile(loadedInputs, {
    platform: { os: 'linux', arch: 'x64', capabilities: {} },
    agnesVersion: '0.1.0',
    now: '2026-09-09T00:00:00Z',
  })
  const deps: AssembleDeps = {
    dataDir,
    profileDir: join(dataDir, 'profiles', 'local-dev'),
    workspaceRoot: workspace,
    homeDir,
    hostRoot: process.cwd(),
    loader: new MemoryPackageLoader(mods),
    audit: createMemoryAudit(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    agnesVersion: '0.1.0',
    env: { ...process.env, ...(opts.shellRequest ? { AGNES_POWERSHELL: opts.shellRequest } : {}) },
    providerFactory: () => new ScriptedProvider({ scripts: [] }),
  }
  const a = await assemble(profile, deps)
  if (!init) throw new Error('sandbox context missing')
  const sessionKey = 'session-a'
  const binding = new WorkspaceBindingAuthority().accept(
    {
      version: 1,
      sessionKey,
      workspaceId: 'a'.repeat(64),
      revision: 1,
      canonicalRoot: realpathSync.native(workspace),
    },
    sessionKey,
  )
  const table = new SessionWorkspaceRuntimeTable()
  try {
    const runtime = await table.open(binding, () => a.openWorkspaceRuntime(binding))
    if (!runtime.seam || !runtime.fencedFs) throw new Error('bound workspace runtime is incomplete')
    a.rollback.push('test-workspace-runtime', () => table.closeAll())
    return {
      a,
      init,
      profile,
      seam: runtime.seam,
      fs: runtime.fencedFs,
      binding,
      runtime,
      table,
      workspace,
      dataDir,
      homeDir,
    }
  } catch (error) {
    await table.closeAll().catch(() => undefined)
    await a.rollback.unwind()
    throw error
  }
}

describe('the bound policy is enforced by the real host FsOps on real directories', () => {
  it('allows workspace and extra roots, denies dataDir with its narrow exceptions', async () => {
    const f = await assembleWithSandbox({})
    try {
      const { fs } = f
      // Workspace allow, relative and absolute.
      await fs.write('inside.txt', bytes)
      await fs.write(join(f.workspace, 'abs.txt'), bytes)
      // dataDir is denied in general...
      await expect(fs.read(join(f.dataDir, 'x'))).rejects.toThrow(/E_FS_DENIED/)
      // ...with the dataDir/tmp exception carved back open...
      await fs.write(join(f.dataDir, 'tmp', 'ok'), bytes)
      // ...and the installation's own secret store hard-denied even under that exception's sibling.
      writeFileSync(join(f.dataDir, 'x'), 'host file', 'utf8')
      mkdirSync(join(f.dataDir, 'secrets'), { recursive: true })
      writeFileSync(join(f.dataDir, 'secrets', 'key'), 'credential', 'utf8')
      await expect(fs.read(join(f.dataDir, 'secrets', 'key'))).rejects.toThrow(/E_FS_DENIED/)
      // ~/.ssh is hard-denied.
      mkdirSync(join(f.homeDir, '.ssh'), { recursive: true })
      writeFileSync(join(f.homeDir, '.ssh', 'id_ed25519'), 'private key', 'utf8')
      await expect(fs.read(join(f.homeDir, '.ssh', 'id_ed25519'))).rejects.toThrow(/E_FS_DENIED/)
      // The host-integrity floor travels in the bound policy.
      mkdirSync(join(f.workspace, '.git'), { recursive: true })
      writeFileSync(join(f.workspace, '.git', 'config'), 'x', 'utf8')
      await expect(fs.read(join(f.workspace, '.git', 'config'))).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('honours extra allow roots and configured denies, by segments and never by string prefix', async () => {
    const extraDir = scratch('agnes-l0-extra-')
    const f = await assembleWithSandbox({
      extraAllow: [extraDir],
      configuredDeny: (dataDir) => [join(extraDir, 'blocked'), join(dataDir, 'tmp', 'agnes-l0-nowhere')],
    })
    try {
      const { fs } = f
      await fs.write(join(extraDir, 'inside.txt'), bytes)
      mkdirSync(join(extraDir, 'blocked'), { recursive: true })
      await expect(fs.write(join(extraDir, 'blocked', 'x'), bytes)).rejects.toThrow(/E_FS_DENIED/)
      // A sibling that shares the workspace's string prefix is not the workspace.
      const sibling = `${f.workspace}-sibling`
      mkdirSync(sibling, { recursive: true })
      dirs.push(sibling)
      writeFileSync(join(sibling, 'x'), 'sibling', 'utf8')
      await expect(fs.read(join(sibling, 'x'))).rejects.toThrow(/E_FS_DENIED/)
      // A configured deny under dataDir/tmp closes part of the exception again.
      await expect(fs.write(join(f.dataDir, 'tmp', 'agnes-l0-nowhere', 'x'), bytes)).rejects.toThrow(
        /E_FS_DENIED/,
      )
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it.runIf(canSymlink)(
    'refuses symlinks that escape, for existing files and not-yet-created targets',
    async () => {
      const outsideDir = scratch('agnes-l0-outside-')
      writeFileSync(join(outsideDir, 'existing.txt'), 'outside', 'utf8')
      mkdirSync(join(outsideDir, 'deep'))
      writeFileSync(join(outsideDir, 'deep', 'file.txt'), 'deep outside', 'utf8')
      const f = await assembleWithSandbox({})
      try {
        const { fs } = f
        symlinkSync(outsideDir, join(f.workspace, 'link'))
        // Existing file through a final symlink.
        await expect(fs.read('link/existing.txt')).rejects.toThrow(/E_FS_DENIED/)
        // A write target that does not exist yet, through a final symlink.
        await expect(fs.write('link/new.txt', bytes)).rejects.toThrow(/E_FS_DENIED/)
        // A parent-chain symlink several segments above the target.
        await expect(fs.read('link/deep/file.txt')).rejects.toThrow(/E_FS_DENIED/)
      } finally {
        await f.a.rollback.unwind()
      }
    },
  )

  it.runIf(canSymlink)(
    're-canonicalizes at operation time: a directory replaced by a symlink after init stops being writable',
    async () => {
      const outsideDir = scratch('agnes-l0-outside-')
      const f = await assembleWithSandbox({})
      try {
        const { fs } = f
        // The rule set was compiled while `future` did not exist; first it is an ordinary
        // directory and writable...
        await fs.mkdir('future')
        await fs.write('future/ok.txt', bytes)
        // ...then it is replaced by a symlink pointing outside the workspace, and the same write
        // must now fail. An implementation that decided at init from the lexical path still allows
        // it; an implementation that cached the earlier success still allows it. Only resolving
        // again at the operation refuses.
        await fs.rm('future', { recursive: true })
        symlinkSync(outsideDir, join(f.workspace, 'future'))
        await expect(fs.write('future/escape.txt', bytes)).rejects.toThrow(/E_FS_DENIED/)
        expect(existsSync(join(outsideDir, 'escape.txt'))).toBe(false)
      } finally {
        await f.a.rollback.unwind()
      }
    },
  )

  it.runIf(canSymlink)(
    'compiles the policy at the real root when the workspace is reached through a symlink',
    async () => {
      const real = scratch('agnes-l0-real-')
      const link = join(scratch('agnes-l0-linkhome-'), 'ws')
      // The target is realpath'd before the link is made: on macOS, `tmpdir()` itself sits under
      // `/var`, which is a symlink to `/private/var`, so an unresolved target would make the fence's
      // walk cross that same OS-level symlink twice (once for `link`, once again for the target) and
      // trip its cycle guard on a coincidence, not a real cycle. Resolving the target first keeps
      // this a single-hop symlink - exactly what the assertion below is pinning - without depending
      // on where the OS happens to put its temp directory.
      symlinkSync(realpathSync.native(real), link)
      const f = await assembleWithSandbox({ workspace: link })
      try {
        // The seam asked the host resolver, not the lexical spelling it was handed.
        expect(f.seam.fsPolicy().workspaceRoot).toBe(realpathSync.native(real))
        expect(f.seam.fsPolicy().workspaceRoot).not.toBe(link)
      } finally {
        await f.a.rollback.unwind()
      }
    },
  )
})

describe('no backend: process creation default-denies, and the marker proves nothing ran', () => {
  it('seam.exec and seam.confine reject SANDBOX_UNAVAILABLE and no child ever starts', async () => {
    const f = await assembleWithSandbox({})
    try {
      const marker = join(f.workspace, 'marker.txt')
      const markerArgv = [SHELL_SENTINEL, `printf x > "${marker}"`]
      const execErr = await f.seam.exec(markerArgv, { cwd: f.workspace }).catch((e: unknown) => e)
      expect(code(execErr)).toBe('SANDBOX_UNAVAILABLE')
      const confineErr = await f.seam
        .confine(['/bin/sh', '-c', `printf x > "${marker}"`])
        .catch((e: unknown) => e)
      expect(code(confineErr)).toBe('SANDBOX_UNAVAILABLE')
      expect(existsSync(marker)).toBe(false)
      // The seam answers honestly while nothing is confined: no process or network scope, ever.
      expect(f.seam.enforcement().scope).not.toContain('process')
      expect(f.seam.enforcement().scope).not.toContain('network')
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('a seam other than sandbox meets the same gate: the bound HostExec refuses without a valid binding', async () => {
    const f = await assembleWithSandbox({})
    try {
      const marker = join(f.workspace, 'marker-other.txt')
      const seamExec = toSeamAdapters(f.a.adapters, { owner: '@agnes/code' }).exec
      const err = await seamExec(['/bin/sh', '-c', `printf x > "${marker}"`], {
        cwd: f.workspace,
      }).catch((e: unknown) => e)
      expect(code(err)).toBe('SANDBOX_UNAVAILABLE')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('the exec gate re-canonicalizes cwd against the policy even when spawning is allowed', async () => {
    const f = await assembleWithSandbox({ sandboxPreset: { on_unavailable: 'allow' } })
    try {
      const err = await f.seam.exec([SHELL_SENTINEL, 'true'], { cwd: f.dataDir }).catch((e: unknown) => e)
      expect(code(err)).toBe('E_FS_DENIED')
      const outside = await f.seam.exec([SHELL_SENTINEL, 'true'], { cwd: tmpdir() }).catch((e: unknown) => e)
      expect(code(outside)).toBe('E_FS_DENIED')
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('does not let another seam bypass an explicitly degraded sandbox without a binding', async () => {
    const f = await assembleWithSandbox({ sandboxPreset: { on_unavailable: 'allow' } })
    try {
      const marker = join(f.workspace, 'marker-unbound-degraded.txt')
      const seamExec = toSeamAdapters(f.a.adapters, { owner: '@agnes/code' }).exec
      const err = await seamExec(['/bin/sh', '-c', `printf x > "${marker}"`], {
        cwd: f.workspace,
      }).catch((e: unknown) => e)
      expect(code(err)).toBe('SANDBOX_UNAVAILABLE')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('a forged or stale policy digest on the exec request is refused', async () => {
    const f = await assembleWithSandbox({ sandboxPreset: { on_unavailable: 'allow' } })
    try {
      const marker = join(f.workspace, 'marker-forged.txt')
      const seamExec = toSeamAdapters(f.a.adapters, { owner: '@agnes/code' }).exec
      const err = await seamExec(['/bin/sh', '-c', `printf x > "${marker}"`], {
        cwd: f.workspace,
        sandbox: { policyDigest: '0'.repeat(64), backend: 'none' },
      } as never).catch((e: unknown) => e)
      expect(code(err)).toBe('SANDBOX_UNAVAILABLE')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('explicit on_unavailable: allow spawns unconfined through the bound exec, and says so', async () => {
    const f = await assembleWithSandbox({ sandboxPreset: { on_unavailable: 'allow' } })
    try {
      const marker = join(f.workspace, 'marker-allowed.txt')
      const command =
        process.platform === 'win32'
          ? `[System.IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'x')`
          : `printf x > "${marker}"`
      const out = await f.seam.exec([SHELL_SENTINEL, command], { cwd: f.workspace })
      expect(out.code).toBe(0)
      expect(existsSync(marker)).toBe(true)
      // Degraded, and reported as such: file-scope partial from the bound FsOps, never more.
      expect(f.seam.enforcement()).toEqual({ level: 'partial', scope: ['file'] })
      const argv = ['/bin/echo', 'hi']
      const wrapped = await f.seam.confine(argv)
      expect(wrapped).toEqual(argv)
      expect(wrapped).not.toBe(argv)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('sandbox.required: true with no backend refuses the workspace runtime before publication', async () => {
    const err = await assembleWithSandbox({ sandboxPreset: { required: true } }).catch((e: unknown) => e)
    expect(code(err)).toBe('E_SANDBOX_WORKSPACE')
  })

  it('the probe exec a sandbox factory is handed is revoked the moment the factory returns', async () => {
    let probe: ((argv: string[], opts: { cwd: string }) => Promise<unknown>) | undefined
    let probeDuringInit: unknown
    let workspace = ''
    const wrapping: SeamFactory = async (ctx) => {
      probe = ctx.sandboxHost?.probeExec
      workspace = ctx.profile.workspaceRoot
      if (!probe) throw new Error('sandbox factory was not handed a probe exec')
      // Inside the init window the probe works: backend detection is what it exists for.
      probeDuringInit = await probe([process.execPath, '-e', ''], { cwd: workspace }).then(
        () => 'ran',
        (e: unknown) => e,
      )
      const factory = (baseSeams as { sandbox?: SeamFactory }).sandbox
      if (!factory) throw new Error('no sandbox seam delivered')
      return factory(ctx)
    }
    const f = await assembleWithSandbox({ sandboxFactory: wrapping })
    try {
      expect(probeDuringInit).toBe('ran')
      const after = await (probe as NonNullable<typeof probe>)([process.execPath, '-e', ''], {
        cwd: workspace,
      }).catch((e: unknown) => e)
      expect(code(after) ?? (after as Error).message).toMatch(/probe|E_SEAM_INIT/)
    } finally {
      await f.a.rollback.unwind()
    }
  })
})

const actualSeatbelt = it.runIf(existsSync('/usr/bin/sandbox-exec'))
actualSeatbelt(
  'executes through the real Seatbelt boundary before opening a required-L1 session',
  async () => {
    const f = await assembleWithSandbox({ sandboxPreset: { level: 'L1', required: true } })
    try {
      expect(f.seam.enforcement()).toEqual({
        level: 'full',
        scope: ['file', 'network', 'process'],
      })
      const marker = join(f.workspace, 'l1-marker.txt')
      const out = await f.seam.exec(['/usr/bin/touch', marker], { cwd: f.workspace })
      expect(out.code).toBe(0)
      expect(existsSync(marker)).toBe(true)
      const session = await createSession(
        f.profile,
        f.a,
        { key: f.binding.sessionKey, binding: f.binding },
        undefined,
        {
          runtime: f.runtime,
          lifecycle: f.table.lifecycle(f.binding.sessionKey),
          children: f.table,
          invocation: f.table.invocation(f.binding.sessionKey),
        },
      )
      await session.close()
    } finally {
      await f.a.rollback.unwind()
    }
  },
)

describe('the binding is held to the seam on every reading of the policy', () => {
  it('a session refuses a per-session sandbox override whose policy digest differs from the bound one', async () => {
    const f = await assembleWithSandbox({})
    try {
      // An override answering a different policy is refused rather than raced onto the shared FsOps.
      const override: SandboxSeam = {
        ...f.seam,
        fsPolicy: () => testFsPolicy(f.workspace),
      }
      const err = await createSession(
        f.profile,
        f.a,
        { key: f.binding.sessionKey, binding: f.binding, seams: { sandbox: override } },
        undefined,
        {
          runtime: f.runtime,
          lifecycle: f.table.lifecycle(f.binding.sessionKey),
          children: f.table,
          invocation: f.table.invocation(f.binding.sessionKey),
        },
      ).catch((e: unknown) => e)
      expect(code(err)).toBe('E_SEAM_IMMUTABLE')
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('the host-bound digest is the seam-computed digest, recorded at bind time', async () => {
    const f = await assembleWithSandbox({})
    try {
      expect(f.runtime.policy).toBe(f.seam.fsPolicy())
      expect(f.runtime.policy.digest).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await f.a.rollback.unwind()
    }
  })

  it('refuses to bind a policy missing the host-integrity floor', async () => {
    const dataDir = scratch('agnes-l0-data-')
    const workspace = scratch('agnes-l0-ws-')
    const bundle = await openAdapters(await resolveProfileForBind(), { dataDir, workspaceRoot: workspace })
    try {
      const noFloor = testFsPolicy(workspace, { floor: false })
      expect(() => bundle.bindFsPolicy(noFloor)).toThrow(/E_SEAM_INIT/)
      // And the failed bind left nothing permissive behind: the fence now refuses everything.
      await expect(bundle.fs.read('anything.txt')).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      await bundle.close()
    }
  })

  it('does not accept a differently-cased integrity floor on a case-sensitive volume', async () => {
    const dataDir = scratch('agnes-l0-data-')
    const workspace = scratch('agnes-l0-ws-')
    const { createPosixPlatform } = await import('../src/adapters/platform.js')
    const detected = createPosixPlatform()
    const platform = { ...detected, fs: () => ({ caseSensitive: true, pathSep: '/' as const }) }
    const bundle = await openAdapters(await resolveProfileForBind(), {
      dataDir,
      workspaceRoot: workspace,
      platform,
    })
    try {
      const valid = bundle.fs.fence()
      const wrongCase = {
        ...valid,
        rules: valid.rules.map((rule) =>
          rule.source === 'host-integrity' && /[\\/]\.git$/.test(rule.path)
            ? { ...rule, path: `${rule.path.slice(0, -4)}.GIT` }
            : rule,
        ),
      }
      expect(wrongCase.rules).not.toEqual(valid.rules)
      expect(() => bundle.bindFsPolicy(wrongCase)).toThrow(/host-integrity floor/)
    } finally {
      await bundle.close()
    }
  })

  // Both names of the workspace secrets directory are floor: `.agh/secrets` is the current one and
  // `.agnes/secrets` the one from before the rename. A policy that drops either is refused.
  it.each(['.agh', '.agnes'])(
    'refuses to bind a policy missing only the %s/secrets hard deny',
    async (name) => {
      const dataDir = scratch('agnes-l0-data-')
      const workspace = scratch('agnes-l0-ws-')
      const bundle = await openAdapters(await resolveProfileForBind(), { dataDir, workspaceRoot: workspace })
      try {
        const valid = bundle.fs.fence()
        const target = new RegExp(`[\\\\/]${name.replace('.', '\\.')}[\\\\/]secrets$`)
        const withoutIt = { ...valid, rules: valid.rules.filter((rule) => !target.test(rule.path)) }
        expect(withoutIt.rules).toHaveLength(valid.rules.length - 1)
        expect(() => bundle.bindFsPolicy(withoutIt)).toThrow(/host-integrity floor/)
      } finally {
        await bundle.close()
      }
    },
  )

  it('an unbound adapter denies process creation and reads nothing outside the bootstrap floor', async () => {
    const dataDir = scratch('agnes-l0-data-')
    const workspace = scratch('agnes-l0-ws-')
    const bundle = await openAdapters(await resolveProfileForBind(), { dataDir, workspaceRoot: workspace })
    try {
      const marker = join(workspace, 'marker-unbound.txt')
      const exec = toSeamAdapters(bundle, { owner: '@agnes/code' }).exec
      const err = await exec(['/bin/sh', '-c', `printf x > "${marker}"`], { cwd: workspace }).catch(
        (e: unknown) => e,
      )
      expect(code(err)).toBe('SANDBOX_UNAVAILABLE')
      expect(existsSync(marker)).toBe(false)
      // Bootstrap floor still holds before any binding.
      await bundle.fs.write('ok.txt', bytes)
      await expect(bundle.fs.read(join(dataDir, 'x'))).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      await bundle.close()
    }
  })
})

async function resolveProfileForBind() {
  return resolveProfile(
    {
      builtin: 'local-dev',
      lock: {
        packages: Object.fromEntries(
          ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
            id,
            { version: '0.1.0', integrity: 'sha512-x', trust: 'builtin' as const, enabled: true },
          ]),
        ),
      },
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-09-09T00:00:00Z',
    },
  )
}

// Real Host file/exec adapters and real Base sandbox/Hook factory; only the extension API event
// registration is captured here. Exact factory-only grant injection has a separate assembly test.
describe
  .runIf(process.platform === 'win32')
  .each(['5.1', ...(process.env.AGNES_TEST_PWSH ? [process.env.AGNES_TEST_PWSH] : [])])(
  'trusted Hook with real PowerShell %s',
  (shellRequest) => {
    it.each([0, 2, 7, 'timeout', 'cancel'] as const)(
      'preserves Hook result %s through the policy-bound seam',
      async (exitCode) => {
        const f = await assembleWithSandbox({ shellRequest, sandboxPreset: { on_unavailable: 'allow' } })
        try {
          const marker = join(f.workspace, 'hook-input.json')
          const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
          const pidFile = join(f.workspace, 'hook.pid')
          const finish =
            exitCode === 'timeout' || exitCode === 'cancel'
              ? `[IO.File]::WriteAllText(${quote(pidFile)}, [string]$PID); Start-Sleep -Seconds 30`
              : `exit ${exitCode}`
          const command = `[IO.File]::WriteAllText(${quote(marker)}, [Console]::In.ReadToEnd()); [Console]::Error.Write('中文拒绝'); ${finish}`
          const bytes = JSON.stringify({
            hooks: {
              PreToolUse: [
                { hooks: [{ type: 'command', command, timeout: exitCode === 'cancel' ? 10 : 2 }] },
              ],
            },
          })
          const configDigest = `sha256-${createHash('sha256').update(bytes).digest('hex')}`
          const capability = trustedHookCommands(
            { trustedUnconfined: [{ source: 'workspace', configDigest, workspaceRoot: f.workspace }] },
            f.workspace,
            f.a.adapters.platform.fs(),
          )
          const handlers = new Map<HookEvent, HookHandler<HookEvent>>()
          const api = {
            registerHook: (event: HookEvent, handler: HookHandler<HookEvent>) => {
              handlers.set(event, handler)
              return () => handlers.delete(event)
            },
            events: { append: async () => 1 },
            ctx: { log: f.init.log },
          } as unknown as ExtensionAPI
          const factory = (trusted: boolean) =>
            baseEcosystem['agnes/hooks-runner']({
              ...f.init,
              sandbox: f.seam,
              ...(trusted && capability ? { trustedHookCommands: capability } : {}),
            })
          const controller = new AbortController()
          // What the Host hands each invocation: the workspace hook file it read, and the sandbox
          // bound to that workspace. Permission is decided against exactly this snapshot.
          const context = {
            session: {
              key: '会话中文🙂',
              lane: 'main',
              workspaceRoot: f.workspace,
              turn: 2,
              step: 3,
            },
            projections: unavailableProjections,
            replayed: false,
            signal: controller.signal,
            lease: { expiresAt: '2099-01-01T00:00:00.000Z', scope: {}, budget: { remaining: 10 } },
            log: f.init.log,
            platform: {
              shell: 'posix',
              fs: { caseSensitive: true, pathSep: '/' },
              terminal: { color: false },
            },
            workspaceHooks: {
              workspaceDigest: configDigest,
              policyRevision: 'test',
              hooks: Object.entries(JSON.parse(bytes).hooks).flatMap(([event, groups]) =>
                (groups as Array<Record<string, unknown>>).map((group) => ({ event, ...group })),
              ),
            },
            [WORKSPACE_HOOK_SANDBOX]: f.seam,
          } as unknown as HookContext
          const call = () =>
            handlers.get('tool_call')?.(
              { name: 'shell', args: { command: '中文 空格 "quotes"' } } as never,
              context,
            )
          // Without the deployment's grant the Hook loads but refuses to run the command unconfined.
          const untrusted = await factory(false)(api)
          try {
            await expect(call()).rejects.toThrow(/explicit trusted permission/)
            expect(existsSync(marker)).toBe(false)
          } finally {
            if (typeof untrusted === 'function') await untrusted()
          }
          expect(handlers.size).toBe(0)
          const dispose = await factory(true)(api)
          try {
            expect(f.a.adapters.powerShell?.version).toMatch(shellRequest === '5.1' ? /^5\.1\./ : /^7\./)
            if (!handlers.get('tool_call')) throw new Error('missing tool_call registration')
            const pending = call()
            if (exitCode === 2)
              await expect(pending).resolves.toMatchObject({ allow: false, reason: '中文拒绝' })
            else if (exitCode === 0) await expect(pending).resolves.toEqual({ allow: true })
            else if (exitCode === 'cancel') {
              const rejected = expect(pending).rejects.toThrow(/hook subprocess failed with exit/)
              try {
                await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true)
                const pid = Number(readFileSync(pidFile, 'utf8'))
                expect(windowsProcessStartTimeSync(pid)).toBeTypeOf('string')
                controller.abort()
                await rejected
                expect(windowsProcessStartTimeSync(pid)).toBeNull()
              } finally {
                controller.abort()
                await rejected
              }
            } else if (exitCode === 'timeout') {
              await expect(pending).rejects.toThrow('hook subprocess timed out')
              const pid = Number(readFileSync(pidFile, 'utf8'))
              expect(pid).toBeGreaterThan(0)
              expect(windowsProcessStartTimeSync(pid)).toBeNull()
            } else await expect(pending).rejects.toThrow('hook subprocess failed with exit 7')
            expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
              session_id: context.session.key,
              hook_event_name: 'PreToolUse',
              cwd: f.workspace,
              args: { command: '中文 空格 "quotes"' },
            })
          } finally {
            if (typeof dispose === 'function') await dispose()
          }
        } finally {
          await f.a.rollback.unwind()
        }
      },
    )
  },
)

// The embedded manifest follows the release assembly route: no captured API and no manual grant
// injection. Profile resolution, extension selection/registration and session hook dispatch are real.
// The hooks-runner row always loads; whether a command may run unconfined is decided on each
// invocation, against the configuration snapshot that invocation actually read.
describe
  .runIf(process.platform === 'win32')
  .each(['5.1', ...(process.env.AGNES_TEST_PWSH ? [process.env.AGNES_TEST_PWSH] : [])])(
  'Host-managed trusted Hook with PowerShell %s',
  (shellRequest) => {
    /** Opens a bound session on the fixture's workspace and asks its hooks about one shell call. */
    const toolCallVerdict = async (f: Fixture) => {
      const session = await createSession(
        f.profile,
        f.a,
        { key: f.binding.sessionKey, binding: f.binding },
        undefined,
        {
          runtime: f.runtime,
          lifecycle: f.table.lifecycle(f.binding.sessionKey),
          children: f.table,
          invocation: f.table.invocation(f.binding.sessionKey),
        },
      )
      try {
        return await session.hooks.toolCall({
          toolUseId: 'real-hook-1',
          name: 'shell',
          args: { command: '中文 "quotes"' },
          meta: {
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: false,
            isOpenWorld: true,
            replay: 'never',
            costHint: undefined,
            deferLoading: false,
            requiresApproval: 'always',
          },
          actor: session.d.actor,
          taint: false,
          resolvedPolicy: {
            isReadOnly: false,
            isDestructive: false,
            replay: 'never',
            requiresApproval: 'always',
            approvalScopes: [],
            policyVersion: 'static-v1',
          },
          executionDomain: 'workspace',
          definitionFingerprint: 'a'.repeat(64),
          policyHash: 'b'.repeat(64),
        })
      } finally {
        await session.close()
      }
    }
    const refused = { allow: false, reason: 'hook execution failed' }

    it('keeps required isolation stronger than a valid deployment grant', async () => {
      // No process backend exists, so a required sandbox refuses the workspace runtime before any
      // session, and so any Hook, can exist; the grant does not change that.
      await expect(
        assembleWithSandbox({
          shellRequest,
          hooksDeployment: 'workspace',
          sandboxPreset: { required: true, on_unavailable: 'allow' },
        }),
      ).rejects.toMatchObject({ code: 'E_SANDBOX_WORKSPACE' })
    })
    it('does not let a valid grant override the default unconfined-execution denial', async () => {
      const f = await assembleWithSandbox({ shellRequest, hooksDeployment: 'workspace' })
      try {
        const marker = join(f.workspace, 'assembly-hook.json')
        expect(await toolCallVerdict(f)).toEqual(refused)
        expect(existsSync(marker)).toBe(false)
      } finally {
        await f.a.rollback.unwind()
      }
    })

    it.each(['workspace', 'data', 'no-grant', 'wrong-digest', 'wrong-source', 'wrong-root'] as const)(
      'runs or refuses the %s deployment through the real Host',
      async (hooksDeployment) => {
        const f = await assembleWithSandbox({
          shellRequest,
          hooksDeployment,
          sandboxPreset: { on_unavailable: 'allow' },
        })
        try {
          const status = f.a.extensionStatus().find((entry) => entry.id === 'agnes/hooks-runner')
          const allowed = hooksDeployment === 'workspace' || hooksDeployment === 'data'
          expect(status).toMatchObject({ loaded: true })
          expect(f.a.kernel.hooks.snapshot().entries('tool_call')).toHaveLength(1)
          const marker = join(f.workspace, 'assembly-hook.json')
          expect(existsSync(marker)).toBe(false)
          const verdict = await toolCallVerdict(f)
          if (!allowed) {
            expect(verdict).toEqual(refused)
            expect(existsSync(marker)).toBe(false)
            return
          }
          expect(verdict).toEqual({ allow: false, reason: '装载链拒绝' })
          const input = JSON.parse(readFileSync(marker, 'utf8')) as { cwd: string }
          expect(input).toMatchObject({
            hook_event_name: 'PreToolUse',
            toolUseId: 'real-hook-1',
            args: { command: '中文 "quotes"' },
          })
          // The session names its workspace by the canonical root, which on Windows expands 8.3 names.
          expect(realpathSync.native(input.cwd)).toBe(realpathSync.native(f.workspace))
        } finally {
          await f.a.rollback.unwind()
        }
      },
    )
  },
)

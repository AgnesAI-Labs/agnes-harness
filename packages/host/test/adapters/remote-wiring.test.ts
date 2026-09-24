import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteSandboxSeam } from '@agnes/sandbox-remote'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAdapters, sandboxHostServices, toSeamAdapters } from '../../src/adapters/index.js'
import { createLoopbackTransport, type RemoteTransport } from '../../src/adapters/remote-transport.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import type { LockState, ResolveEnv } from '../../src/profile/types.js'
import { WorkspaceBindingAuthority } from '../../src/workspace-authority.js'

// Toggled only by the close()-failure test below: everything else in this file must see the real
// loopback transport's exec behave exactly as it always has.
const rmFault = { active: false }
// Every transport `openAdapters` builds internally, in creation order. The open-path leak test needs
// a handle on a transport whose `openAdapters` call never returned, so there is no bundle to read it
// off; nothing else in this file consults it.
const created: RemoteTransport[] = []

// Inject failures through the test vendor factory while retaining real loopback operations.
vi.mock('../../src/adapters/remote-transport.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapters/remote-transport.js')>()
  return {
    ...real,
    createLoopbackTransport: (opts: { root: string }) => {
      const t = real.createLoopbackTransport(opts)
      const wrapped = {
        ...t,
        exec: async (cmd: Parameters<typeof t.exec>[0], o: Parameters<typeof t.exec>[1]) => {
          if (rmFault.active && cmd[0] === 'rm')
            throw new Error('simulated transport failure: rm -rf rejected')
          return t.exec(cmd, o)
        },
      }
      created.push(wrapped)
      return wrapped
    },
  }
})

// Resolve a real profile and inject the package-owned channel factory.
const env: ResolveEnv = {
  platform: { os: 'linux', arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-16T00:00:00Z',
}
const lock: LockState = {
  packages: {
    '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin', enabled: true },
    '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin', enabled: true },
    '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin', enabled: true },
  },
}

const localProfile = () => resolveProfile({ builtin: 'local-dev', lock }, env)
const remoteSeamProfile = (
  root: string,
  config: Record<string, import('@agnes/protocol').JsonValue> = {
    rootTemplate: `${root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1')}/sessions/{session}`,
  },
) =>
  resolveProfile(
    {
      builtin: 'local-dev',
      lock: {
        packages: {
          ...lock.packages,
          '@agnes/sandbox-remote': { version: '1', integrity: 'test', trust: 'trusted', enabled: true },
        },
      },
      user: {
        name: 'p',
        seams: { sandbox: '@agnes/sandbox-remote' },
        packages: [{ id: '@agnes/sandbox-remote', source: 'test', config }],
      },
    },
    env,
  )
const remoteModules = () =>
  new Map([
    [
      '@agnes/sandbox-remote',
      {
        id: '@agnes/sandbox-remote',
        openTransport: async () => createLoopbackTransport({ root: '/' }),
      },
    ],
  ])

describe('remote assembly wiring (RA17)', () => {
  let dir: string
  const paths = () => {
    // realpath'ed: under remote mode the workspace root is taken as an already-canonical remote path
    // (RA15) and is no longer run through this machine's realpath, so a fixture handing over
    // `/var/...` where the volume's real name is `/private/var/...` would be fencing a spelling the
    // remote io then canonicalizes to something else. Real remote roots arrive canonical; so does
    // this one.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-remote-wiring-')))
    const dataDir = join(dir, 'data')
    const workspaceRoot = join(dir, 'work')
    mkdirSync(workspaceRoot, { recursive: true })
    return { dataDir, workspaceRoot }
  }
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses when an exported transport has no package config', async () => {
    const opts = paths()
    const profile = await remoteSeamProfile(dir)
    const selected = profile.packages.find((p) => p.id === '@agnes/sandbox-remote')
    if (!selected) throw new Error('missing fixture package')
    const { config: _config, ...entry } = selected
    await expect(
      openAdapters({ ...profile, packages: [entry] }, { ...opts, modules: remoteModules() }),
    ).rejects.toThrow(/config/i)
  })

  it('does not open a transport exported by an unselected package', async () => {
    const opts = paths()
    const profile = await localProfile()
    const before = created.length
    const bundle = await openAdapters(profile, { ...opts, modules: remoteModules() })
    try {
      expect(bundle.transport).toBeUndefined()
      expect(created).toHaveLength(before)
    } finally {
      await bundle.close()
    }
  })

  it('refuses a config block that carries no usable rootTemplate', async () => {
    const opts = paths()
    const profile = await remoteSeamProfile(dir, {})
    await expect(openAdapters(profile, { ...opts, modules: remoteModules() })).rejects.toThrow(/root/i)
  })

  it('opens a transport and hands the exact same handle to the sandbox factory when both agree', async () => {
    const { dataDir, workspaceRoot } = paths()
    const profile = await remoteSeamProfile(dir)
    const bundle = await openAdapters(profile, {
      dataDir,
      workspaceRoot,
      modules: remoteModules(),
    })
    try {
      expect(bundle.transport).toBeDefined()
      expect(bundle.transport?.alive()).toBe(true)
      const { services, revoke } = sandboxHostServices(bundle)
      expect(services.transport).toBe(bundle.transport)
      revoke()
    } finally {
      await bundle.close()
    }
    // close() owns the channel it opened: it must not outlive the bundle.
    expect(bundle.transport?.alive()).toBe(false)
  })

  it('leaves a local deployment with no transport at all - byte-identical to before this task', async () => {
    const { dataDir, workspaceRoot } = paths()
    const profile = await localProfile()
    const bundle = await openAdapters(profile, { dataDir, workspaceRoot })
    try {
      expect(bundle.transport).toBeUndefined()
      expect(sandboxHostServices(bundle).services.transport).toBeUndefined()
    } finally {
      await bundle.close()
    }
  })

  it('still closes the transport when the remote workspace fails to close', async () => {
    const { dataDir, workspaceRoot } = paths()
    const profile = await remoteSeamProfile(dir)
    const bundle = await openAdapters(profile, {
      dataDir,
      workspaceRoot,
      modules: remoteModules(),
    })
    expect(bundle.transport?.alive()).toBe(true)
    await bundle.openWorkspace(
      new WorkspaceBindingAuthority().accept(
        {
          version: 1,
          sessionKey: 'session-a',
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: workspaceRoot,
        },
        'session-a',
      ),
    )
    rmFault.active = true
    try {
      // The workspace's own `rm -rf` rejects, so close() still surfaces that failure - this test
      // is not asking it to be swallowed, only that it not skip the transport shutdown that comes
      // after it.
      await expect(bundle.close()).rejects.toThrow(/remote workspace pool close failed/i)
    } finally {
      rmFault.active = false
    }
    // The transport is this bundle's to close, whether or not the workspace it wraps came down
    // cleanly - a leaked channel here is a live connection once Stage B fits a real transport.
    expect(bundle.transport?.alive()).toBe(false)
  })

  it('refuses malformed host settings before opening the channel', async () => {
    const opts = paths()
    const profile = await remoteSeamProfile(dir, { rootTemplate: '/sessions/{session}', keepOnClose: 'yes' })
    created.length = 0
    await expect(openAdapters(profile, { ...opts, modules: remoteModules() })).rejects.toThrow(/keepOnClose/)
    expect(created).toHaveLength(0)
  })

  it('takes the remote workspace root as given instead of resolving it against this machine', async () => {
    const { dataDir, workspaceRoot } = paths()
    const link = join(dir, 'link')
    symlinkSync(workspaceRoot, link)
    // The fixture's own premise: locally, `link` and `workspaceRoot` are two names for one
    // directory, and realpathSync prefers the second. A remote-absolute path that also happens to
    // exist on this machine is exactly the case where the old local canonicalization silently
    // re-pointed the fence at this machine's answer.
    expect(realpathSync(link)).toBe(workspaceRoot)
    const profile = await remoteSeamProfile(dir)
    const bundle = await openAdapters(profile, {
      dataDir,
      workspaceRoot: link,
      modules: remoteModules(),
    })
    try {
      expect(bundle.fs.fence().workspaceRoot).toBe(link)
    } finally {
      await bundle.close()
    }
  })

  it('still resolves the workspace root against the local disk for a local deployment', async () => {
    const { dataDir, workspaceRoot } = paths()
    const link = join(dir, 'link')
    symlinkSync(workspaceRoot, link)
    const profile = await localProfile()
    const bundle = await openAdapters(profile, { dataDir, workspaceRoot: link })
    try {
      expect(bundle.fs.fence().workspaceRoot).toBe(workspaceRoot)
    } finally {
      await bundle.close()
    }
  })

  it('folds case for a remote volume it has not measured, so a deny cannot be spelled around', async () => {
    const { dataDir, workspaceRoot } = paths()
    // The file the bootstrap fence hard-denies really exists, the way it does in any checkout; the
    // probe below asks for the same directory under a different spelling.
    mkdirSync(join(workspaceRoot, '.git'), { recursive: true })
    const profile = await remoteSeamProfile(dir)
    const bundle = await openAdapters(profile, {
      dataDir,
      workspaceRoot,
      modules: remoteModules(),
    })
    try {
      // The fence's own decision is the observable. `<root>/.GIT` matches the workspace allow rule
      // whatever the case semantics are - ancestry does not look at the leaf - so the only thing
      // that can refuse it is the `.git` hard deny matching too, which needs folding. With
      // `caseSensitive: true` this call RESOLVES, on a remote volume that is case-insensitive
      // handing out a path into the very directory the deny names.
      await expect(bundle.fs.realpath(join(workspaceRoot, '.GIT'))).rejects.toThrow(/E_FS_DENIED/)
      // The plainly-spelled deny keeps refusing, and the workspace root itself keeps resolving:
      // folding is not being bought by degrading the fence into deny-all.
      await expect(bundle.fs.realpath(join(workspaceRoot, '.git'))).rejects.toThrow(/E_FS_DENIED/)
      await expect(bundle.fs.realpath(workspaceRoot)).resolves.toBe(workspaceRoot)
    } finally {
      await bundle.close()
    }
  })
})

describe('the remote seam over a real openAdapters bundle (C1: the exec gate is in the path)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const openRemote = async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-remote-seam-')))
    const dataDir = join(dir, 'data')
    const workspaceRoot = join(dir, 'work')
    const homeDir = join(dir, 'home')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    const profile = await remoteSeamProfile(dir)
    const bundle = await openAdapters(profile, {
      dataDir,
      workspaceRoot,
      modules: remoteModules(),
    })
    return { bundle, dataDir, workspaceRoot, homeDir }
  }

  // The real assembly hands the sandbox factory exactly these two objects (assemble/packages.ts):
  // `toSeamAdapters(bundle, ...)` for `adapters` and `sandboxHostServices(bundle).services` for
  // `sandboxHost`. Building the context from them rather than from a double is the whole point -
  // this is the first place in the branch where the seam's own declarations reach the real gate,
  // the real platform capability table and the real bindFsPolicy.
  const fitSeam = async (
    bundle: Awaited<ReturnType<typeof openAdapters>>,
    p: { workspaceRoot: string; dataDir: string; homeDir: string; preset?: Record<string, unknown> },
  ) => {
    const { services, revoke } = sandboxHostServices(bundle)
    try {
      return await remoteSandboxSeam({
        profile: { ...p, preset: p.preset ?? {} },
        adapters: toSeamAdapters(bundle, { owner: 'test' }),
        sandboxHost: services,
      })
    } finally {
      revoke()
    }
  }

  it('declares the remote posture, so the gate and sandbox.l1 both answer honestly', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    try {
      expect(bundle.execGate()).toEqual({ backend: 'none', onUnavailable: 'deny' })
      expect(bundle.platform.capability('sandbox.l1').reason ?? '').not.toMatch(/remote host boundary/)
      await fitSeam(bundle, { workspaceRoot, dataDir, homeDir })
      // Task 1's widened enum now has a production producer: 'remote', not the 'none' that RA7 plus
      // the gate's fourth check would deadlock on (spec §4.6.1).
      expect(bundle.execGate()).toEqual({ backend: 'remote', onUnavailable: 'deny' })
      // Task 2's remote branch now has one too, reached through the real platform backend rather
      // than hand-fed into a double. This is the reason §4.7's E_PRESET_UNSUPPORTED quotes.
      const l1 = bundle.platform.capability('sandbox.l1')
      expect(l1.level).toBe('unavailable')
      expect(l1.reason).toMatch(/remote host boundary/)
    } finally {
      await bundle.close()
    }
  })

  it('binds the seam-compiled policy through the real bindFsPolicy without poisoning the fence', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    try {
      const seam = await fitSeam(bundle, {
        workspaceRoot,
        dataDir,
        homeDir,
        preset: { sandbox: { extra_paths: ['vendor'], deny_paths: ['secret.env'] } },
      })
      const policy = seam.fsPolicy()
      bundle.bindFsPolicy(policy)
      // A refused bind does not throw quietly - it poisons the fence to deny-all - so both halves
      // are asserted: the digest is pinned, and the fence still serves the workspace afterwards.
      expect(bundle.fsBinding().policyDigest).toBe(policy.digest)
      expect(bundle.fs.fence().digest).toBe(policy.digest)
      await expect(bundle.fs.realpath(workspaceRoot)).resolves.toBe(workspaceRoot)
      await expect(bundle.fs.realpath(join(workspaceRoot, '.git'))).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      await bundle.close()
    }
  })

  it('runs exec on the remote host through the gate, and refuses a cwd the policy does not allow', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    try {
      const seam = await fitSeam(bundle, { workspaceRoot, dataDir, homeDir })
      bundle.bindFsPolicy(seam.fsPolicy())
      const ok = await seam.exec(['sh', '-c', 'printf ran'], { cwd: workspaceRoot })
      expect(ok).toMatchObject({ code: 0, stdout: 'ran' })
      // The whole point of C1. `dataDir` is outside the compiled policy's allow rules, and the only
      // thing that ever applies those rules to an exec request is createPolicyExec's authorizeCwd.
      // Forwarding to the transport directly - what this seam used to do - runs this command.
      await expect(seam.exec(['sh', '-c', 'printf ran'], { cwd: dataDir })).rejects.toThrow(/E_FS_DENIED/)
      // Same for the workspace's own hard-denied host-integrity paths.
      await expect(
        seam.exec(['sh', '-c', 'printf ran'], { cwd: join(workspaceRoot, '.git') }),
      ).rejects.toThrow(/E_FS_DENIED/)
    } finally {
      await bundle.close()
    }
  })

  it('refuses a gated exec whose cwd spells a hard-denied path in another case', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    try {
      mkdirSync(join(workspaceRoot, '.git'), { recursive: true })
      const seam = await fitSeam(bundle, { workspaceRoot, dataDir, homeDir })
      bundle.bindFsPolicy(seam.fsPolicy())
      // Same directory, two spellings. The gate's `authorizeCwd` is the fence, so if the fence does
      // not fold case the deny simply is not matched and the command runs in the denied directory -
      // it still matches the workspace allow rule, which never looked at the leaf's case.
      await expect(
        seam.exec(['sh', '-c', 'printf ran'], { cwd: join(workspaceRoot, '.GIT') }),
      ).rejects.toThrow(/E_FS_DENIED/)
      // And the workspace itself still runs, so the refusal above is the deny matching rather than
      // the whole fence having been folded shut.
      await expect(seam.exec(['sh', '-c', 'printf ran'], { cwd: workspaceRoot })).resolves.toMatchObject({
        code: 0,
        stdout: 'ran',
      })
    } finally {
      await bundle.close()
    }
  })

  it('does not carry AGNES_SECRET_* onto the remote host through the gated exec', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    process.env.AGNES_SECRET_REVIEW_PROBE = 'leaked-to-the-remote-host'
    try {
      const seam = await fitSeam(bundle, { workspaceRoot, dataDir, homeDir })
      bundle.bindFsPolicy(seam.fsPolicy())
      // End to end, through exactly the path a package's tool call takes: seam.exec -> the host
      // exec gate -> createRemoteExec -> the transport. A credential this host holds must not be
      // readable by a command running on the other machine.
      const got = await seam.exec(['sh', '-c', 'printf %s "$AGNES_SECRET_REVIEW_PROBE"'], {
        cwd: workspaceRoot,
      })
      expect(got).toMatchObject({ code: 0, stdout: '' })
    } finally {
      delete process.env.AGNES_SECRET_REVIEW_PROBE
      await bundle.close()
    }
  })

  it('refuses an exec whose binding does not name the bound policy', async () => {
    const { bundle, dataDir, workspaceRoot, homeDir } = await openRemote()
    try {
      const seam = await fitSeam(bundle, { workspaceRoot, dataDir, homeDir })
      // Nothing bound yet: the gate's first two checks are as live under remote mode as under a
      // local one, and a seam that skipped the gate would sail past both.
      await expect(seam.exec(['sh', '-c', 'printf ran'], { cwd: workspaceRoot })).rejects.toThrow(
        /SANDBOX_UNAVAILABLE/,
      )
    } finally {
      await bundle.close()
    }
  })
})

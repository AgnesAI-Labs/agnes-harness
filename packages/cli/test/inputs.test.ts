import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { hashWorkspace, type LockState, lockPath } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import {
  makeEphemeralHome,
  type ProfileFlags,
  profileNameFrom,
  readProfileInputs,
  resolveHome,
} from '../src/boot/inputs.js'
import { BootError, UsageError } from '../src/errors.js'

const tmp: string[] = []
const scratch = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `agnes-${tag}-`))
  tmp.push(d)
  return d
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const flagsFor = (cwd: string, o: Partial<ProfileFlags> = {}): ProfileFlags => ({
  profile: 'local-dev',
  park: false,
  cwd,
  ...o,
})

describe('resolveHome', () => {
  it('prefers AGH_HOME, then the legacy AGNES_HOME, otherwise .agh under HOME', () => {
    expect(resolveHome({ AGH_HOME: resolve('/x/agh'), AGNES_HOME: resolve('/x/agnes'), HOME: '/h' })).toBe(
      resolve('/x/agh'),
    )
    expect(resolveHome({ AGNES_HOME: resolve('/x/agnes'), HOME: '/h' })).toBe(resolve('/x/agnes'))
    expect(resolveHome({ HOME: resolve('/h') })).toBe(join(resolve('/h'), '.agh'))
  })

  // An unset variable and one set to the empty string reach a process the same way often enough
  // that the difference cannot be left to `??`, which keeps '' and would resolve every path to the
  // filesystem root.
  it('an empty AGH_HOME or AGNES_HOME is treated as unset, not as the root directory', () => {
    expect(resolveHome({ AGH_HOME: '', HOME: resolve('/h') })).toBe(join(resolve('/h'), '.agh'))
    expect(resolveHome({ AGNES_HOME: '', HOME: resolve('/h') })).toBe(join(resolve('/h'), '.agh'))
    expect(resolveHome({ AGH_HOME: '', AGNES_HOME: resolve('/x/agnes'), HOME: '/h' })).toBe(
      resolve('/x/agnes'),
    )
  })

  it('falls back to the account home when HOME itself is missing', () => {
    const home = resolveHome({})
    expect(home).toBe(join(homedir(), '.agh'))
    expect(home).not.toBe('/.agh')
  })

  // The same reading for HOME, and it is the one with teeth: `??` keeps the empty string, and
  // join('', '.agh') is the *relative* path '.agh', so every profile would be looked up under
  // whatever directory the process happened to start in.
  it('an empty HOME is treated as unset, and never yields a relative path', () => {
    const home = resolveHome({ HOME: '' })
    expect(home).toBe(join(homedir(), '.agh'))
    expect(isAbsolute(home)).toBe(true)
    expect(home).not.toBe('.agh')
  })

  // Delegated to host's paths module: a relative home variable is refused here too, naming the
  // variable that was actually used, rather than silently resolved against process.cwd().
  it('refuses a relative AGH_HOME or AGNES_HOME instead of resolving it against the cwd', () => {
    expect(() => resolveHome({ AGH_HOME: 'relative/agh', HOME: '/h' })).toThrow(/AGH_HOME/)
    expect(() => resolveHome({ AGNES_HOME: 'relative/agnes', HOME: '/h' })).toThrow(/AGNES_HOME/)
  })

  // AGNES_HOME is not consulted at all once AGH_HOME is set, so a stale relative legacy value
  // cannot fail a boot that names a valid home.
  it('ignores a relative AGNES_HOME when AGH_HOME is set', () => {
    expect(resolveHome({ AGH_HOME: resolve('/x/agh'), AGNES_HOME: 'relative/agnes' })).toBe(resolve('/x/agh'))
  })
})

describe('profileNameFrom', () => {
  it('--profile beats AGNES_PROFILE beats local-dev', () => {
    expect(profileNameFrom(parseArgs(['--profile', 'p1']), { AGNES_PROFILE: 'p2' })).toBe('p1')
    expect(profileNameFrom(parseArgs([]), { AGNES_PROFILE: 'p2' })).toBe('p2')
    expect(profileNameFrom(parseArgs([]), {})).toBe('local-dev')
    expect(profileNameFrom(parseArgs([]), { AGNES_PROFILE: '' })).toBe('local-dev')
  })

  // The name is pasted into a path under the home directory. Anything that is not one plain
  // directory name would read a profile from somewhere else entirely.
  it.each([
    ['../../etc', 'profile name ../../etc is not a single path segment'],
    ['a/b', 'profile name a/b is not a single path segment'],
    ['..', 'profile name .. is not a single path segment'],
    ['.', 'profile name . is not a single path segment'],
    ['', 'profile name  is not a single path segment'],
  ])('rejects %s', (name, message) => {
    expect(() => profileNameFrom(parseArgs(['--profile', name]), {})).toThrow(UsageError)
    expect(() => profileNameFrom(parseArgs(['--profile', name]), {})).toThrow(message)
    // The same name arriving from the environment is refused too, not only from the flag.
    if (name !== '') expect(() => profileNameFrom(parseArgs([]), { AGNES_PROFILE: name })).toThrow(message)
  })

  it('accepts the ordinary names', () => {
    for (const n of ['local-dev', 'enterprise', 'acme.prod', 'p1'])
      expect(profileNameFrom(parseArgs(['--profile', n]), {})).toBe(n)
  })
})

describe('readProfileInputs', () => {
  it('reads the user profile and the cwd overlay, and builds no flags layer at all', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    mkdirSync(join(home, 'profiles', 'local-dev'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'local-dev', 'profile.yaml'),
      `name: local-dev\ndataDir: ${join(home, 'data')}\n`,
    )
    mkdirSync(join(cwd, '.agh'))
    writeFileSync(join(cwd, '.agh', 'profile.local.yaml'), 'limits:\n  "session.max_steps": 5\n')

    const inputs = await readProfileInputs({
      home,
      cwd,
      flags: flagsFor(cwd, { preset: 'standard', park: true }),
      agnesVersion: '0.0.0',
    })
    expect(inputs.builtin).toBe('local-dev')
    expect(inputs.user?.name).toBe('local-dev')
    expect(inputs.user?.dataDir).toBe(join(home, 'data'))
    expect(inputs.local?.limits).toEqual({ 'session.max_steps': 5 })
    expect(inputs.flags).toBeUndefined()
    expect(inputs.workspaceOverlay).toBeUndefined()
  })

  it('omits the layers whose files are absent rather than carrying undefined values', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(inputs).toEqual({ builtin: 'local-dev' })
    expect(Object.hasOwn(inputs, 'user')).toBe(false)
    expect(Object.hasOwn(inputs, 'local')).toBe(false)
    expect(Object.hasOwn(inputs, 'flags')).toBe(false)
  })

  // host refuses every flags layer (E_DEP_MISSING), so one built here could only ever turn a boot
  // into a refusal naming an internal layer rather than the flag the user typed -- which is what
  // `--park` and `--preset` used to do, both with the identical string. None of the three is a
  // profile input any more: --preset rides on session/new, and --park and --model are refused by
  // name in modes/print.ts.
  it.each([
    [{ preset: 'standard' }],
    [{ park: true }],
    [{ model: { slot: 'primary', route: 'gateway', model: 'deepseek-v4' } }],
    [{ preset: 'standard', park: true }],
    [{}],
  ])('no flag reaches a profile layer: %j', async (o) => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const inputs = await readProfileInputs({
      home,
      cwd,
      flags: flagsFor(cwd, o as Partial<ProfileFlags>),
      agnesVersion: '0.0.0',
    })
    expect(inputs.flags).toBeUndefined()
    expect(Object.hasOwn(inputs, 'flags')).toBe(false)
  })

  // --model picks a model for one session, which is a session.setModel call after session/new, not
  // a profile input. A profile layer carrying it would outlive the run that asked for it.
  it('--model never reaches the profile layers', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const inputs = await readProfileInputs({
      home,
      cwd,
      flags: flagsFor(cwd, { model: { slot: 'primary', route: 'gateway', model: 'deepseek-v4' } }),
      agnesVersion: '0.0.0',
    })
    expect(JSON.stringify(inputs)).not.toContain('deepseek-v4')
  })

  it('reads the overlay from the cwd it is given, not from the process working directory', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const other = scratch('other')
    mkdirSync(join(other, '.agh'))
    writeFileSync(join(other, '.agh', 'profile.local.yaml'), 'limits:\n  "session.max_steps": 9\n')
    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(inputs.local).toBeUndefined()
    const there = await readProfileInputs({ home, cwd: other, flags: flagsFor(other), agnesVersion: '0.0.0' })
    expect(there.local?.limits).toEqual({ 'session.max_steps': 9 })
  })

  // The workspace directory is .agh now; an overlay left under the old .agnes name is not read.
  it('does not read a profile.local.yaml left under the legacy .agnes directory', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    mkdirSync(join(cwd, '.agnes'))
    writeFileSync(join(cwd, '.agnes', 'profile.local.yaml'), 'limits:\n  "session.max_steps": 7\n')
    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(inputs.local).toBeUndefined()
  })

  it('names the file it could not parse instead of failing somewhere further in', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    mkdirSync(join(cwd, '.agh'))
    const bad = join(cwd, '.agh', 'profile.local.yaml')
    writeFileSync(bad, 'limits:\n  - "session.max_steps": [unclosed\n')
    const err = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BootError)
    expect((err as BootError).message).toContain(bad)
    expect((err as BootError).code).toBe(2)
    expect((err as BootError).cause).toBeInstanceOf(Error)
  })

  it('a yaml file that parses to something other than a mapping is refused', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    mkdirSync(join(home, 'profiles', 'local-dev'), { recursive: true })
    const file = join(home, 'profiles', 'local-dev', 'profile.yaml')
    writeFileSync(file, '- one\n- two\n')
    const err = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(BootError)
    expect((err as BootError).message).toContain('is not a mapping')
  })

  it('refuses a profile name that would step outside the profiles directory', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    await expect(
      readProfileInputs({ home, cwd, flags: flagsFor(cwd, { profile: '../..' }), agnesVersion: '0.0.0' }),
    ).rejects.toThrow('profile name ../.. is not a single path segment')
  })

  // The lockfile a profile carries on disk is the lock layer now. The fixture carries every field
  // the schema makes required - resolvedProfileHash is a real hash shape, seams the closed ten-key
  // object, and an npm entry its license/releasedAt/dependencies - because readLock validates
  // before anything projects.
  const lockfileDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    lockfileVersion: 1,
    profile: 'local-dev',
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    generatedAt: '2026-09-07T00:00:00Z',
    generatedBy: { agnesVersion: '0.0.0' },
    packages: {
      '@agnes/base': {
        version: '0.1.0',
        source: { type: 'npm', ref: 'npm:@agnes/base@0.1.0' },
        integrity: 'sha512-x',
        trust: 'builtin',
        license: 'MIT',
        state: { installed: '2026-09-07T00:00:00Z', trusted: '2026-09-07T00:00:00Z', enabled: true },
        releasedAt: '2026-09-07T00:00:00Z',
        dependencies: {},
        previous: null,
      },
    },
    seams: {
      approval: '@agnes/base',
      checkpoint: '@agnes/base',
      ledger: '@agnes/base',
      sandbox: '@agnes/base',
      verifier: '@agnes/base',
      repair: '@agnes/base',
      artifacts: '@agnes/base',
      principals: '@agnes/base',
      platform: '@agnes/base',
      harness: '@agnes/base',
    },
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'] },
    policySnapshot: { capabilityCeiling: [], workspacePackages: 'require-project-trust' },
    ...over,
  })

  it('reads the profile lockfile into the lock layer when none is injected', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const profileDir = join(home, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(lockPath(profileDir), JSON.stringify(lockfileDoc()))
    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(inputs.lock?.packages['@agnes/base']).toMatchObject({
      version: '0.1.0',
      integrity: 'sha512-x',
      trust: 'builtin',
      enabled: true,
    })
    expect(inputs.workspaceOverlay).toBeUndefined()
  })

  it('verifies and exposes a signed workspace overlay from the profile lockfile', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const profileDir = join(home, 'profiles', 'local-dev')
    const deployDir = join(profileDir, 'deploy', 'xinwei')
    mkdirSync(join(deployDir, 'profile'), { recursive: true })
    mkdirSync(join(deployDir, 'preset'), { recursive: true })
    mkdirSync(join(deployDir, 'fixtures', 'in'), { recursive: true })
    writeFileSync(join(deployDir, 'profile', 'profile.yaml'), 'policy:\n  capabilityCeiling: [tools]\n')
    writeFileSync(join(deployDir, 'preset', 'enterprise.yaml'), 'name: enterprise\n')
    writeFileSync(
      join(deployDir, 'manifest.json'),
      JSON.stringify({
        id: 'xinwei',
        version: '1.0.0',
        harnessRange: '^0.1.0',
        extensions: [],
        profileFragment: 'profile/profile.yaml',
        presets: ['preset/enterprise.yaml'],
        fixtures: 'fixtures/in',
      }),
    )
    writeFileSync(
      lockPath(profileDir),
      JSON.stringify(
        lockfileDoc({
          workspace: {
            path: 'deploy/xinwei',
            hash: hashWorkspace(deployDir),
            manifestId: 'xinwei',
            trustedAt: '2026-09-07T00:00:00Z',
          },
        }),
      ),
    )

    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(inputs.lock?.workspace?.manifestId).toBe('xinwei')
    expect(inputs.workspaceOverlay).toEqual({ policy: { capabilityCeiling: ['tools'] } })
  })

  it('leaves the lock layer off entirely when there is no lockfile to read', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    mkdirSync(join(home, 'profiles', 'local-dev'), { recursive: true })
    const inputs = await readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' })
    expect(Object.hasOwn(inputs, 'lock')).toBe(false)
  })

  it('an explicitly injected lock wins over the file on disk', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const profileDir = join(home, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(lockPath(profileDir), JSON.stringify(lockfileDoc()))
    const injected: LockState = {
      packages: { '@agnes/ai': { version: '9.9.9', integrity: 'sha512-y', trust: 'builtin', enabled: true } },
    }
    const inputs = await readProfileInputs({
      home,
      cwd,
      flags: flagsFor(cwd),
      agnesVersion: '0.0.0',
      lock: injected,
    })
    expect(inputs.lock).toBe(injected)
  })

  // A lockfile that exists but does not validate is a refusal, not an empty lock: treating it as
  // absent would boot unlocked exactly when a lock was declared.
  it('refuses a lockfile that does not validate instead of booting unlocked', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const profileDir = join(home, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(lockPath(profileDir), JSON.stringify({ lockfileVersion: 2 }))
    await expect(
      readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' }),
    ).rejects.toThrow(/E_LOCK_MISMATCH/)
  })

  // host cannot verify a workspace section in this build (Task 17), so it fails closed rather than
  // dropping the attestation on the floor.
  it('refuses a lockfile carrying a workspace section', async () => {
    const home = scratch('home')
    const cwd = scratch('cwd')
    const profileDir = join(home, 'profiles', 'local-dev')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      lockPath(profileDir),
      JSON.stringify(
        lockfileDoc({
          workspace: {
            path: 'deploy/xinwei',
            hash: `sha256-${'1'.repeat(64)}`,
            manifestId: 'xinwei',
            trustedAt: '2026-09-07T00:00:00Z',
          },
        }),
      ),
    )
    await expect(
      readProfileInputs({ home, cwd, flags: flagsFor(cwd), agnesVersion: '0.0.0' }),
    ).rejects.toThrow(/E_LOCK_MISMATCH/)
  })
})

describe('makeEphemeralHome', () => {
  it('is a fresh directory that dispose removes', () => {
    const e = makeEphemeralHome()
    expect(existsSync(e.home)).toBe(true)
    e.dispose()
    expect(existsSync(e.home)).toBe(false)
  })

  it('two calls do not share a directory', () => {
    const a = makeEphemeralHome()
    const b = makeEphemeralHome()
    try {
      expect(a.home).not.toBe(b.home)
    } finally {
      a.dispose()
      b.dispose()
    }
  })

  it('dispose removes what is inside it and can be called twice', () => {
    const e = makeEphemeralHome()
    mkdirSync(join(e.home, 'profiles', 'p'), { recursive: true })
    writeFileSync(join(e.home, 'profiles', 'p', 'profile.yaml'), 'name: p\n')
    e.dispose()
    expect(existsSync(e.home)).toBe(false)
    expect(() => e.dispose()).not.toThrow()
  })
})

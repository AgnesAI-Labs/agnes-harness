import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITY_IDS,
  type ConfigurationService,
  createConfigurationService,
  createPlatform,
  type ResolvedProfile,
} from '@agnes/host'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { doctorBinary } from '../src/commands/doctor-local.js'
import {
  doctorPlatform,
  doctorProfile,
  doctorResolvedProfile,
  resolveDoctorProfile,
} from '../src/commands/doctor-profile.js'
import { TEST_LOCK } from './boot-host.js'

const setup = () => {
  const home =
    process.platform === 'win32'
      ? join(tmpdir(), `agnes-profile-doctor-${randomUUID()}`)
      : mkdtempSync(join(tmpdir(), 'agnes-profile-doctor-'))
  if (process.platform === 'win32') createPrivateDirectorySync(home)
  return { home, cwd: home, env: {}, agnesVersion: '0', log: () => {}, lock: TEST_LOCK }
}
describe('profile and platform doctor', () => {
  it('reports real probed capabilities and warns about degraded capability levels', async () => {
    const d = setup()
    try {
      const report = await doctorPlatform(d)
      expect(report.status).toBe('warn')
      for (const id of CAPABILITY_IDS)
        expect(report.detail.some((line) => line.startsWith(`${id}=`))).toBe(true)
      expect(report.detail).toContain('ipc=full')
      expect(report.detail).toContain('terminal.kitty-keys=unavailable')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('says why a capability is below full, and tells an unprobed sandbox from a failed probe', async () => {
    const d = setup()
    try {
      const unprobed = createPlatform()
      const before = (await doctorPlatform(d, unprobed)).detail
      // The doctor does not start a sandbox backend, so the sandbox rows are still waiting.
      const l1 = before.indexOf('sandbox.l1=unavailable')
      expect(l1).toBeGreaterThanOrEqual(0)
      expect(before[l1 + 1]).toBe('sandbox.l1.reason=awaiting sandbox backend full-boundary probe')
      expect(before).toContain('sandbox.network.reason=awaiting sandbox backend full-boundary probe')
      // The level lines keep their old shape, so a reader of "key=value" lines is not surprised.
      expect(before).toContain('terminal.kitty-keys=unavailable')
      expect(before).toContain('terminal.kitty-keys.reason=negotiated at TUI start')
      // Full capabilities carry no reason line, even when the platform recorded a note for them.
      const noted = createPlatform()
      const withNote = {
        ...noted,
        probe: async () => undefined,
        snapshot: () => ({
          ...noted.snapshot(),
          capabilities: { ...noted.snapshot().capabilities, 'terminal.truecolor': 'full' as const },
        }),
        capability: (id: string) =>
          id === 'terminal.truecolor'
            ? { level: 'full' as const, scope: [], reason: 'a note that must stay off the full row' }
            : noted.capability(id),
      }
      const fullRow = (await doctorPlatform(d, withNote)).detail
      expect(fullRow).toContain('terminal.truecolor=full')
      expect(fullRow.some((line) => line.startsWith('terminal.truecolor.reason='))).toBe(false)
      expect(before).toContain('ipc=full')
      expect(before.some((line) => line.startsWith('ipc.reason='))).toBe(false)

      // A backend that was probed and failed says so, in different words.
      const failed = createPlatform()
      failed.recordSandboxBackend({ name: 'none', enforcement: { level: 'none', scope: [] } })
      // probe() resets the table to its "awaiting" defaults, so the recorded failure is kept by
      // not probing again here.
      const after = (await doctorPlatform(d, { ...failed, probe: async () => undefined })).detail
      expect(after).toContain(
        'sandbox.l1.reason=no runnable OS sandbox backend passed its full-boundary probe',
      )
      expect(after).not.toContain('sandbox.l1.reason=awaiting sandbox backend full-boundary probe')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('fails the profile section when the default preset is not in presets.allowed, and says so', () => {
    const profile = (presets: { default: string; allowed: string[] }) =>
      ({
        name: 'local-dev',
        hash: 'sha256-x',
        packages: [{ id: '@agnes/base' }],
        dataDir: '/data',
        cacheDir: '/cache',
        presets,
      }) as unknown as ResolvedProfile

    const ok = doctorResolvedProfile(profile({ default: 'chtd', allowed: ['chtd', 'standard'] }))
    expect(ok.status).toBe('ok')
    expect(ok.detail).toContain('presets default chtd, allowed chtd, standard')

    const bad = doctorResolvedProfile(profile({ default: 'chtd', allowed: ['cthd'] }))
    expect(bad.status).toBe('fail')
    expect(bad.detail).toContain('presets default chtd, allowed cthd')
    expect(bad.detail.join('\n')).toContain('presets.default "chtd" is not in presets.allowed')

    expect(doctorResolvedProfile(profile({ default: 'chtd', allowed: [] })).detail).toContain(
      'presets default chtd, allowed (none)',
    )
  })
  it('uses the default local-dev path and passes the resolved custom cache to the actual binary check', async () => {
    const d = setup()
    try {
      const dir = join(d.home, 'profiles', 'local-dev'),
        cache = join(d.home, 'custom-cache')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'profile.yaml'), `name: local-dev\ncacheDir: ${JSON.stringify(cache)}\n`)
      const p = parseArgs(['doctor'])
      const profile = await resolveDoctorProfile(d, p)
      expect(profile.name).toBe('local-dev')
      expect(profile.cacheDir).toBe(cache)
      expect((await doctorProfile(d, p)).detail).toContain(`cacheDir ${cache}`)
      expect((await doctorBinary(d, profile.cacheDir)).status).toBe('ok')
      expect(readdirSync(join(cache, 'jiti', '0'))).toEqual([])
      expect(existsSync(join(d.home, 'cache'))).toBe(false)
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  // Without homeDir wired through, an unconfigured profile's default expanded against the raw OS
  // account home instead of d.home -- correct for a plain `agnes doctor` run, wrong the moment
  // AGH_HOME or an ephemeral home differs from it, and exactly how a stray sessions.db ends up at
  // the OS home root instead of the scratch directory a test, or a probe, actually meant to use.
  it('resolves the default dataDir against d.home, not the raw OS account home', async () => {
    const d = setup()
    try {
      const profile = await resolveDoctorProfile(d, parseArgs(['doctor']))
      expect(profile.dataDir).toBe(join(d.home, 'data'))
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  // Accounts saved through setup live in configuration.json, not profile.yaml. A doctor profile that
  // skipped them assembled a host with no provider.routes, so provider / extensions / code-runtime
  // all reported "host assembly failed" on a machine whose prompts were answering fine.
  it('layers the saved account configuration in, as a prompt boot does', async () => {
    const d = setup()
    try {
      const configuration = {
        profileInput: async () => ({
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              { route: 'acct-test', api: 'openai-completions', baseUrl: 'https://example.invalid/v1' },
            ],
            catalog: { include: [] },
          },
        }),
      } as unknown as ConfigurationService
      const profile = await resolveDoctorProfile({ ...d, configuration }, parseArgs(['doctor']))
      expect(profile.provider.routes?.map((r) => r.route)).toEqual(['acct-test'])
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  // Providers configured through onboarding or Web settings live in configuration.json, not in
  // profile.yaml. CLI boot and the daemon overlay them; doctor used to skip the overlay, so every
  // host-backed section (provider, extensions, code-runtime) failed with no-routes for exactly the
  // users who configured a provider the supported way.
  it('overlays provider accounts saved through the configuration service, like CLI boot', async () => {
    const d = setup()
    try {
      let model = ''
      const request = (async () =>
        new Response(JSON.stringify({ data: [{ id: model }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof globalThis.fetch
      const configuration = createConfigurationService({ home: d.home, profile: 'local-dev', request })
      model = (await configuration.test({ providerId: 'deepseek' })).models[0]?.id ?? ''
      if (!model) throw new Error('deepseek catalogue is empty')
      await configuration.save({
        providerId: 'deepseek',
        apiKey: 'sk-test-value',
        model,
        expectedRevision: 0,
      })
      const profile = await resolveDoctorProfile(d, parseArgs(['doctor']))
      expect(profile.provider.routes?.length ?? 0).toBeGreaterThan(0)
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('declares an unlocked builtin-only default profile healthy, stamped from the build', async () => {
    const d = setup()
    try {
      const { lock: _lock, ...unlocked } = d
      // Since the builtin exemption, a fresh machine without an agnes-lock.json resolves the
      // builtin-only local-dev template instead of refusing it.
      const s = await doctorProfile(unlocked, parseArgs(['doctor']))
      expect(s.status).toBe('ok')
      expect(s.detail).toContain('packages @agnes/ai, @agnes/base, @agnes/code')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('still fails an unlocked profile naming a package outside the builtin set', async () => {
    const d = setup()
    try {
      const { lock: _lock, ...unlocked } = d
      const dir = join(d.home, 'profiles', 'local-dev')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'profile.yaml'),
        'name: local-dev\npackages:\n  - { id: "@acme/x", source: "npm" }\n',
      )
      expect((await doctorProfile(unlocked, parseArgs(['doctor']))).status).toBe('fail')
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
  it('rejects profile traversal without echoing the supplied path', async () => {
    const d = setup()
    try {
      expect(await doctorProfile(d, parseArgs(['doctor', '--profile', '../private']))).toEqual({
        name: 'profile',
        status: 'fail',
        detail: ['profile resolution failed'],
      })
    } finally {
      rmSync(d.home, { recursive: true, force: true })
    }
  })
})

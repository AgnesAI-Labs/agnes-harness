import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPABILITY_IDS, type ConfigurationService, createConfigurationService } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { doctorBinary } from '../src/commands/doctor-local.js'
import { doctorPlatform, doctorProfile, resolveDoctorProfile } from '../src/commands/doctor-profile.js'
import { TEST_LOCK } from './boot-host.js'

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'agnes-profile-doctor-'))
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

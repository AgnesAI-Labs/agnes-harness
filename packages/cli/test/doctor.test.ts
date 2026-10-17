import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHome } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, usage } from '../src/args.js'
import type { DoctorCommandDeps } from '../src/commands/doctor.js'
import { doctorCommand, renderSections } from '../src/commands/doctor.js'

const cleanup: string[] = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deps(): DoctorCommandDeps {
  const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-command-'))
  cleanup.push(home)
  return {
    env: {},
    home,
    cwd: home,
    agnesVersion: '0',
    log: () => undefined,
    // Let the closed builtin set resolve against this test's actual runtime version.
    lock: { packages: {} },
    createHostImpl: async () => (await createTestHost({ dataDir: home })).host,
  }
}

describe('doctor command aggregation', () => {
  it('fails Computer Use-only selectors closed before running ordinary doctor sections', async () => {
    const d = deps()
    const result = await doctorCommand(parseArgs(['doctor', 'storage', '--include', 'binary']), d)
    expect(result).toEqual({
      text: '--include and --skip are only supported by doctor computer-use',
      json: [],
      exitCode: 2,
    })
  })

  it('requires an explicit provider probe flag and keeps the ordinary doctor grammar closed', async () => {
    expect(parseArgs(['doctor', 'provider', '--probe']).probe).toBe(true)
    expect(parseArgs(['doctor', '--probe']).probe).toBe(true)
    expect(parseArgs(['doctor', 'storage']).probe).toBe(false)
    expect(() => parseArgs(['doctor', 'storage', '--probe'])).toThrow(
      '--probe is supported only by doctor or doctor provider',
    )
  })

  it('keeps default provider doctor bounded in both text and JSON forms', async () => {
    const d = deps()
    const text = await doctorCommand(parseArgs(['doctor', 'provider']), d)
    expect(text.exitCode).toBe(0)
    expect(text.text).toContain('no configured provider route selected')
    const json = await doctorCommand(parseArgs(['doctor', 'provider', '--json']), d)
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.text)).toEqual(json.json)
    expect(json.text).not.toContain('minimal_inference')
  })

  it.skipIf(process.platform === 'win32')(
    'locates unsafe credential directories, files and locks with safe repair hints',
    async () => {
      const d = deps()
      chmodSync(d.home, 0o700)
      const provider = join(d.home, 'secrets', "provider's")
      mkdirSync(provider, { recursive: true, mode: 0o700 })
      chmodSync(join(d.home, 'secrets'), 0o700)
      const file = join(provider, 'default')
      writeFileSync(file, 'doctor-private-canary', { mode: 0o644 })
      mkdirSync(join(d.home, 'locks'), { mode: 0o755 })
      const result = await doctorCommand(parseArgs(['doctor', 'credentials']), d)
      expect(result.exitCode).toBe(1)
      expect(result.text).toContain('expectedMode=0600')
      expect(result.text).toContain('expectedMode=0700')
      expect(result.text).toContain('chmod -- 0600')
      expect(result.text).toContain('chmod -- 0700')
      expect(result.text).toContain("provider'\"'\"'s")
      expect(result.text).toContain('locks: unsafe')
      expect(result.text).not.toContain('doctor-private-canary')
      expect(readFileSync(file, 'utf8')).toBe('doctor-private-canary')
    },
  )

  it('warns in provider doctor for an enabled account whose credential is absent', async () => {
    const d = deps()
    d.configuration = {
      get: async () => ({
        profile: 'local-dev',
        revision: 1,
        configured: false,
        provider: null,
        defaultAccountId: 'missing',
        effect: 'new-sessions',
        accounts: [
          {
            accountId: 'missing',
            label: 'Missing',
            providerId: 'deepseek',
            route: 'account-missing',
            baseUrl: 'https://unused.invalid',
            model: 'm',
            models: [{ id: 'm', name: 'M' }],
            enabled: true,
            credentialConfigured: false,
          },
        ],
      }),
    } as never
    const result = await doctorCommand(parseArgs(['doctor', 'provider', '--json']), d)
    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual([expect.objectContaining({ name: 'provider', status: 'warn' })])
    expect(result.text).not.toContain('unused.invalid')
  })

  it.each(['extensions', 'code-runtime'])(
    'classifies %s setup separately from assembly faults',
    async (section) => {
      const d = deps()
      for (const [code, reason, status] of [
        ['E_PRESET_UNRESOLVED', 'no-routes', 'warn'],
        ['E_SEAM_INIT', 'no-routes', 'fail'],
        ['E_PRESET_UNRESOLVED', 'unknown-route', 'fail'],
      ] as const) {
        d.createHostImpl = async () => {
          throw Object.assign(new Error('private body'), { code, detail: { reason } })
        }
        const result = await doctorCommand(parseArgs(['doctor', section]), d)
        expect(result.json[0]?.status).toBe(status)
        if (status === 'fail') expect(result.text).toContain(code)
        expect(result.text).not.toContain('private body')
      }
    },
  )

  it('runs an independent section and renders exact JSON', async () => {
    const d = deps()
    const result = await doctorCommand(parseArgs(['doctor', 'storage', '--json']), d)

    expect(result.exitCode).toBe(0)
    expect(result.json).toHaveLength(1)
    expect(result.json[0]).toMatchObject({ name: 'storage', status: 'ok' })
    expect(JSON.parse(result.text)).toEqual(result.json)
  })

  it('resolves a custom profile cache before running binary diagnostics', async () => {
    const d = deps()
    const profileDir = join(d.home, 'profiles', 'local-dev')
    const cacheDir = join(d.home, 'custom-cache')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'profile.yaml'),
      `name: local-dev\ncacheDir: ${JSON.stringify(cacheDir)}\n`,
    )

    const result = await doctorCommand(parseArgs(['doctor', 'binary']), d)

    expect(result.exitCode).toBe(0)
    expect(result.json).toEqual([
      {
        name: 'binary',
        status: 'ok',
        detail: ['sea: no', 'jiti cache write/read verified'],
      },
    ])
    expect(existsSync(join(cacheDir, 'jiti', '0'))).toBe(true)
  })

  it('does not mention activation recovery when no breadcrumb file exists', async () => {
    const d = deps()
    const daemon = await doctorCommand(parseArgs(['doctor', 'daemon']), d)
    expect(daemon.json).toEqual([{ name: 'daemon', status: 'warn', detail: ['not running'] }])
  })

  it('fails closed on a corrupt owner record without echoing its contents', async () => {
    const d = deps()
    const daemonDir = join(d.home, 'daemon')
    mkdirSync(daemonDir, { recursive: true })
    writeFileSync(join(daemonDir, 'owner.json'), '{"secret":"sk-do-not-print"}')

    const result = await doctorCommand(parseArgs(['doctor', 'daemon']), d)
    expect(result).toEqual({
      text: '✗ daemon\n    daemon diagnostic failed',
      exitCode: 1,
      json: [{ name: 'daemon', status: 'fail', detail: ['daemon diagnostic failed'] }],
    })
    expect(result.text).not.toContain('sk-do-not-print')
  })

  it('lists shared first-run checks and rejects unknown or extra section arguments', async () => {
    const d = deps()
    initializeHome(d.home)
    const result = await doctorCommand(parseArgs(['doctor']), d)
    expect(result.json.find((section) => section.name === 'accounts')?.status).toBe('warn')
    expect(result.json.map((section) => section.name)).toEqual([
      'node',
      'native',
      'home',
      'permissions',
      'credentials',
      'sandbox',
      'connection',
      'disk',
      'accounts',
      'plugins',
      'mcp',
    ])
    expect(result.json.every((section) => section.fixHintKey?.startsWith('doctor.fix.'))).toBe(true)
    expect(usage()).toContain(
      'doctor [platform|network|provider|storage|credentials|profile|extensions|daemon|binary|code-runtime]',
    )
    expect(usage()).not.toContain('doctor [provider|sandbox')

    await expect(doctorCommand(parseArgs(['doctor', 'sandbox']), d)).resolves.toMatchObject({
      exitCode: 2,
      json: [],
    })
    await expect(doctorCommand(parseArgs(['doctor', 'storage', 'unexpected']), d)).resolves.toMatchObject({
      exitCode: 2,
      json: [],
    })
  })

  it('renders status marks and indents details', () => {
    expect(
      renderSections([
        { name: 'healthy', status: 'ok', detail: ['ready'] },
        { name: 'degraded', status: 'warn', detail: ['partial'] },
        { name: 'broken', status: 'fail', detail: ['offline'] },
      ]),
    ).toBe('✓ healthy\n    ready\n! degraded\n    partial\n✗ broken\n    offline')
  })
})

describe('home inspection and startup guidance', () => {
  it('keeps home inspection read-only and explains an unsupported layout', async () => {
    const { homeCommand } = await import('../src/commands/home.js')
    const { main } = await import('../src/bin.js')
    const parent = deps().home
    const home = join(parent, 'fresh')
    let output = '',
      error = ''
    const io = {
      env: { AGH_HOME: home, AGNES_LOCALE: 'zh-CN' },
      cwd: parent,
      stdout: {
        write(value: string) {
          output += value
        },
      },
      stderr: {
        write(value: string) {
          error += value
        },
      },
    } as unknown as Parameters<typeof main>[1]
    expect(await main(['home', 'info'], io)).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ state: 'fresh', version: null })
    expect(existsSync(home)).toBe(false)
    mkdirSync(home)
    writeFileSync(join(home, 'unknown.txt'), 'synthetic')
    expect(await homeCommand(['info'], io)).toBe(1)
    expect(error).toContain('不能使用此布局')
    expect(error).toContain('AGH_HOME')
    expect(readFileSync(join(home, 'unknown.txt'), 'utf8')).toBe('synthetic')
  })
  it.each([
    ['old', undefined],
    ['broken', '{'],
    ['future', '{"version":99}'],
  ] as const)(
    'shows the selected absolute home and fixed %s reason without changing the home',
    async (_kind, marker) => {
      const d = deps()
      const { initializeHome } = await import('@agnes/host')
      const { startupFailure } = await import('../src/commands/first-run-locales.js')
      const filename = join(d.home, marker === undefined ? 'legacy.txt' : 'home-layout.json')
      const bytes = marker ?? 'synthetic old environment'
      writeFileSync(filename, bytes)
      let failure: unknown
      try {
        initializeHome(d.home)
      } catch (error) {
        failure = error
      }
      for (const locale of ['en', 'zh-CN']) {
        const text = startupFailure(failure, { AGNES_LOCALE: locale })
        expect(text).toContain(d.home)
        expect(text).toContain('E_HOME_VERSION')
        expect(text).toContain(
          locale === 'zh-CN' ? 'README.zh-CN.md#new-product-clean-home' : 'README.md#new-product-clean-home',
        )
        expect(text).toContain(
          marker === undefined
            ? locale === 'zh-CN'
              ? '旧环境目录'
              : 'Old environment directory'
            : locale === 'zh-CN'
              ? '布局标记无效'
              : 'layout marker is invalid',
        )
      }
      expect(readFileSync(filename, 'utf8')).toBe(bytes)
      expect(existsSync(join(d.home, 'profiles'))).toBe(false)
      rmSync(filename)
      expect(initializeHome(d.home).state).toBe('current')
    },
  )
  it('maps common startup codes to actionable text without exposing exception messages', async () => {
    const { startupFailure } = await import('../src/commands/first-run-locales.js')
    for (const code of [
      'EADDRINUSE',
      'EACCES',
      'CONFIG_CREDENTIAL_STORE',
      'E_HOME_VERSION',
      'E_HOME_UNSAFE',
      'E_DAEMON_SCOPE_CONFLICT',
      'E_DAEMON_BUSY',
      'E_DAEMON_STARTUP_BUSY',
    ]) {
      const error = Object.assign(new Error('PRIVATE UPSTREAM BODY'), { code })
      const en = startupFailure(error, {})
      const zh = startupFailure(error, { AGNES_LOCALE: 'zh-CN' })
      expect(en).toBeTruthy()
      expect(zh).toBeTruthy()
      expect(en).not.toBe(zh)
      expect(en + String(zh)).not.toContain('PRIVATE UPSTREAM BODY')
      if (code === 'E_HOME_UNSAFE') {
        expect(en).toContain('parent directory')
        expect(en).toContain('pwd -P')
        expect(zh).toContain('pwd -P')
      }
    }
    expect(startupFailure(new Error('unmapped'), {})).toBeUndefined()
  })
})

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, usage } from '../src/args.js'
import type { DoctorCommandDeps } from '../src/commands/doctor.js'
import { doctorCommand, renderSections } from '../src/commands/doctor.js'
import { TEST_LOCK } from './boot-host.js'

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
    lock: TEST_LOCK,
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
    expect(parseArgs(['doctor', 'storage']).probe).toBe(false)
    expect(() => parseArgs(['doctor', 'storage', '--probe'])).toThrow(
      '--probe is supported only by doctor provider',
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

  it('fails default provider doctor for an enabled account whose credential is absent', async () => {
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
    expect(result.exitCode).toBe(1)
    expect(result.json).toEqual([expect.objectContaining({ name: 'provider', status: 'fail' })])
    expect(result.text).not.toContain('unused.invalid')
  })

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

  it('uses one real Host for extensions and reports an absent daemon as a warning', async () => {
    const d = deps()
    let hostBuilds = 0
    d.createHostImpl = async () => {
      hostBuilds++
      return (await createTestHost({ dataDir: d.home })).host
    }

    const extensions = await doctorCommand(parseArgs(['doctor', 'extensions']), d)
    expect(extensions.json).toEqual([
      { name: 'extensions', status: 'ok', detail: ['no extensions declared'] },
    ])
    expect(hostBuilds).toBe(1)

    const daemon = await doctorCommand(parseArgs(['doctor', 'daemon']), d)
    expect(daemon).toEqual({
      text: '! daemon\n    not running',
      exitCode: 0,
      json: [{ name: 'daemon', status: 'warn', detail: ['not running'] }],
    })
    expect(hostBuilds).toBe(1)
  })

  it('does not mention activation recovery when no breadcrumb file exists', async () => {
    const d = deps()
    const daemon = await doctorCommand(parseArgs(['doctor', 'daemon']), d)
    expect(daemon.json).toEqual([{ name: 'daemon', status: 'warn', detail: ['not running'] }])
  })

  it.skipIf(process.platform === 'win32')('probes the real daemon owner and unix socket', async () => {
    const d = deps()
    const daemonDir = join(d.home, 'data', 'daemon')
    const socketPath = join(daemonDir, 'agnesd.sock')
    mkdirSync(daemonDir, { recursive: true })
    const identity = await defaultProcessIdentity(process.pid)
    if (identity.state !== 'alive') throw new Error('test process identity is unavailable')
    writeFileSync(
      join(daemonDir, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        processStartId: identity.startId,
        generation: randomUUID(),
        startedAt: new Date().toISOString(),
        socketPath,
      }),
    )
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(doctorCommand(parseArgs(['doctor', 'daemon']), d)).resolves.toEqual({
        text: '✓ daemon\n    lock: ok\n    socket: ok',
        exitCode: 0,
        json: [{ name: 'daemon', status: 'ok', detail: ['lock: ok', 'socket: ok'] }],
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('fails closed on a corrupt owner record without echoing its contents', async () => {
    const d = deps()
    const daemonDir = join(d.home, 'data', 'daemon')
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

  it('lists the nine sections and rejects unknown or extra section arguments', async () => {
    const d = deps()
    const result = await doctorCommand(parseArgs(['doctor']), d)
    expect(result.json.map((section) => section.name)).toEqual([
      'platform',
      'provider',
      'storage',
      'credentials',
      'profile',
      'extensions',
      'daemon',
      'binary',
      'code-runtime',
    ])
    expect(result.exitCode).toBe(1)
    expect(usage()).toContain(
      'doctor [platform|provider|storage|credentials|profile|extensions|daemon|binary|code-runtime]',
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

describe.runIf(process.platform !== 'win32')('doctor credentials section', () => {
  const store = (home: string, mode: number) => {
    mkdirSync(join(home, 'secrets', 'openai'), { recursive: true })
    writeFileSync(join(home, 'secrets', 'openai', 'default'), 'sk-test-secret-value', { mode: 0o600 })
    for (const directory of [join(home, 'secrets', 'openai'), join(home, 'secrets'), home])
      chmodSync(directory, 0o700)
    for (const base of ['auth', 'locks']) {
      mkdirSync(join(home, base), { recursive: true })
      chmodSync(join(home, base), 0o700)
    }
    chmodSync(home, mode)
  }
  const run = async (home: string) => {
    const d = deps()
    d.home = home
    return doctorCommand(parseArgs(['doctor', 'credentials']), d)
  }

  it('passes for a private store and reads no credential contents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-'))
    cleanup.push(home)
    store(home, 0o700)
    const result = await run(home)
    expect(result.json).toEqual([
      {
        name: 'credentials',
        status: 'ok',
        detail: [expect.stringMatching(/^\d+ credential store entries checked/)],
      },
    ])
    expect(result.text).not.toContain('sk-test-secret-value')
    expect(result.exitCode).toBe(0)
  })

  it('reports a home that does not exist yet as fine', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-')), 'absent')
    cleanup.push(join(home, '..'))
    const result = await run(home)
    expect(result.json[0]).toMatchObject({ name: 'credentials', status: 'ok' })
    expect(result.json[0]?.detail[0]).toContain('does not exist')
  })

  it('warns, with the modes and the fix, for a loose home the next save narrows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-'))
    cleanup.push(home)
    store(home, 0o755)
    const result = await run(home)
    expect(result.json[0]).toMatchObject({ name: 'credentials', status: 'warn' })
    expect(result.json[0]?.detail).toEqual([
      expect.stringContaining('mode 0755, must be 0700; the next credential save narrows it'),
    ])
    expect(result.json[0]?.detail[0]).toContain(`chmod 700 '${home}'`)
    expect(result.exitCode).toBe(0)
    expect(statSync(home).mode & 0o7777).toBe(0o755) // the check never changes anything
  })

  it('fails, with no promise to narrow it, for a home that others can write to', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-'))
    cleanup.push(home)
    store(home, 0o775)
    const result = await run(home)
    expect(result.json[0]).toMatchObject({ name: 'credentials', status: 'fail' })
    expect(result.json[0]?.detail[0]).toContain('mode 0775, must be 0700; run: chmod 700')
    expect(result.json[0]?.detail[0]).not.toContain('narrows')
    expect(result.exitCode).toBe(1)
  })

  it('fails for a loose secrets directory and a loose credential file, naming each', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-'))
    cleanup.push(home)
    store(home, 0o700)
    chmodSync(join(home, 'secrets'), 0o755)
    chmodSync(join(home, 'secrets', 'openai', 'default'), 0o644)
    const result = await run(home)
    expect(result.json[0]).toMatchObject({ status: 'fail' })
    const detail = result.json[0]?.detail.join('\n') ?? ''
    expect(detail).toContain(`secrets directory ${join(home, 'secrets')}: mode 0755, must be 0700`)
    expect(detail).toContain('credential file')
    expect(detail).toContain('mode 0644, must be 0600')
    expect(detail).not.toContain('sk-test-secret-value')
    expect(result.exitCode).toBe(1)
  })

  it('fails for a symbolic link in place of the secrets directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-cred-'))
    cleanup.push(home)
    store(home, 0o700)
    const elsewhere = mkdtempSync(join(tmpdir(), 'agnes-doctor-link-'))
    cleanup.push(elsewhere)
    rmSync(join(home, 'secrets'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(home, 'secrets'))
    const result = await run(home)
    expect(result.json[0]).toMatchObject({ status: 'fail' })
    expect(result.json[0]?.detail[0]).toContain('is a symbolic link')
  })
})

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Readable } from 'node:stream'
import { readProfileTelemetryConsent } from '@agnes/host'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { consentCommand } from '../src/commands/consent.js'
import { statsDeviation } from '../src/commands/stats.js'
import type { BootDeps } from '../src/types.js'

// `profile trust` is the first `profile` subcommand that needs a live client, so its dispatch test
// below stubs bootDefault rather than booting a real daemon: no other test in this file calls a
// bootDefault-backed command, so mocking it here does not affect them.
const trustFixture = vi.hoisted(() => ({ calls: [] as unknown[], closed: false }))
vi.mock('../src/boot/default.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/boot/default.js')>()
  return {
    ...actual,
    bootDefault: vi.fn(async () => ({
      client: {
        async clientId() {
          return 'cli-client'
        },
        packages: {
          trustWorkspace: async (params: unknown) => {
            trustFixture.calls.push(params)
            return { hash: `sha256-${'a'.repeat(64)}` }
          },
        },
      },
      profileName: 'local-dev',
      resolvedProfileHash: null,
      bootMs: 0,
      form: 'local' as const,
      close: async () => {
        trustFixture.closed = true
      },
    })),
  }
})

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function deps(): BootDeps {
  const home = mkdtempSync(join(tmpdir(), 'agnes-misc-'))
  cleanup.push(home)
  return { env: {}, home, cwd: home, agnesVersion: '0', log: () => undefined }
}

describe('consent', () => {
  it('writes a private profile overlay and rejects unknown or extra tiers', () => {
    const d = deps()
    expect(consentCommand(parseArgs(['consent', 'ANON']), d)).toContain('ANON')
    const file = join(d.home, 'profiles', 'local-dev', 'consent.yaml')
    expect(readFileSync(file, 'utf8')).toBe('telemetry:\n  consent: ANON\n')
    expect(readProfileTelemetryConsent(join(d.home, 'profiles', 'local-dev'))).toBe('ANON')
    if (process.platform === 'win32') expect(hasPrivateDaclSync(file)).toBe(true)
    else expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(() => consentCommand(parseArgs(['consent', 'MAYBE']), d)).toThrow(/DISABLED\|LOCAL\|ANON\|FULL/)
    expect(() => consentCommand(parseArgs(['consent', 'ANON', 'FULL']), d)).toThrow()
  })

  it('enforces stepwise FULL consent using the current profile overlay', () => {
    const d = deps()
    expect(() => consentCommand(parseArgs(['consent', 'FULL']), d)).toThrow(/cannot transition directly/)
    consentCommand(parseArgs(['consent', 'ANON']), d)
    expect(consentCommand(parseArgs(['consent', 'FULL']), d)).toContain('FULL')
  })

  it('atomically replaces rather than follows an existing consent symlink', () => {
    const d = deps()
    const profile = join(d.home, 'profiles', 'local-dev')
    mkdirSync(profile, { recursive: true })
    const outside = join(d.home, 'outside')
    chmodSync(profile, 0o700)
    symlinkSync(outside, join(profile, 'consent.yaml'))

    consentCommand(parseArgs(['consent', 'LOCAL']), d)
    expect(readFileSync(join(profile, 'consent.yaml'), 'utf8')).toContain('LOCAL')
    expect(() => readFileSync(outside, 'utf8')).toThrow()
  })

  it('is dispatched by the executable without booting a session', async () => {
    const d = deps()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: d.home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: d.cwd,
      agnesVersion: d.agnesVersion,
    }

    expect(await main(['consent', 'ANON'], io)).toBe(0)
    expect(await main(['consent', 'FULL'], io)).toBe(0)
    expect(out).toContain('local-dev: FULL')
  })
})

describe('stats deviation', () => {
  it('prints zero rows without creating a database', async () => {
    const d = deps()
    expect(await statsDeviation(parseArgs(['stats', 'deviation']), d)).toMatch(/^0 rows/)
    expect(await statsDeviation(parseArgs(['stats', 'deviation', '--json']), d)).toBe('[]')
  })

  it('groups stored deviations and uses request counts as denominators', async () => {
    const d = deps()
    const data = join(d.home, 'data')
    mkdirSync(data)
    const db = new DatabaseSync(join(data, 'sessions.db'))
    db.exec('CREATE TABLE events (ts TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)')
    for (const row of [
      ['request/header', { model: 'flash' }],
      ['request/header', { model: 'flash' }],
      ['format/deviation', { model: 'flash', rule: 'inline', parserVersion: '1' }],
      ['format/deviation', { model: 'flash', rule: 'inline', parserVersion: '1' }],
      ['format/deviation', { model: 'orphan', responseModel: 'actual', rule: 'think', parserVersion: '2' }],
    ] as const)
      insert.run('2026-09-11T00:00:00.000Z', row[0], JSON.stringify(row[1]))
    db.close()

    const json = JSON.parse(await statsDeviation(parseArgs(['stats', 'deviation', '--json']), d)) as Array<
      Record<string, unknown>
    >
    expect(json).toEqual([
      {
        model: 'flash',
        rule: 'inline',
        parserVersion: '1',
        count: 2,
        requests: 2,
        rate: 1,
      },
      {
        model: 'orphan',
        responseModel: 'actual',
        rule: 'think',
        parserVersion: '2',
        count: 1,
        requests: 0,
        rate: 0,
      },
    ])
    expect(await statsDeviation(parseArgs(['stats', 'deviation']), d)).toContain('2/2\t100.00%')
  })

  it('treats a pre-ledger database as empty but surfaces corrupt event JSON', async () => {
    const d = deps()
    const data = join(d.home, 'data')
    mkdirSync(data)
    let db = new DatabaseSync(join(data, 'sessions.db'))
    db.exec('CREATE TABLE old_schema (value TEXT)')
    db.close()
    expect(await statsDeviation(parseArgs(['stats', 'deviation']), d)).toBe('0 rows')

    rmSync(join(data, 'sessions.db'))
    db = new DatabaseSync(join(data, 'sessions.db'))
    db.exec('CREATE TABLE events (ts TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)')
    db.prepare('INSERT INTO events VALUES (?, ?, ?)').run('2026-09-11', 'format/deviation', '{')
    db.close()
    await expect(statsDeviation(parseArgs(['stats', 'deviation']), d)).rejects.toThrow()
  })
})

describe('profile list', () => {
  it('is dispatched by the executable without booting a session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-list-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'list'], io)).toBe(0)
    expect(out).toContain('local-dev\t(builtin template)')
  })
})

describe('profile inspect', () => {
  it('returns UsageError when no profile name is provided', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-no-name-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'inspect'], io)).not.toBe(0)
    expect(out).toContain('profile inspect requires a profile name')
  })

  it('prints short summary when inspecting a profile without --resolved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'inspect', 'local-dev'], io)).toBe(0)
    expect(out).toContain('local-dev')
    expect(out).toContain('dataDir')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('prints resolved profile as JSON when --resolved is provided', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-inspect-resolved-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'inspect', 'local-dev', '--resolved'], io)).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.name).toBe('local-dev')
    expect(typeof parsed.hash).toBe('string')
    expect(typeof parsed.dataDir).toBe('string')
  })
})

describe('profile trust', () => {
  afterEach(() => {
    trustFixture.calls.length = 0
    trustFixture.closed = false
  })

  it('returns UsageError when no deploy directory is provided', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-trust-no-arg-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'trust'], io)).not.toBe(0)
    expect(out).toContain('profile trust requires a deploy directory')
    // Never boots when the argument is missing: the check happens before bootDefault runs.
    expect(trustFixture.calls).toEqual([])
  })

  it('boots a client, resolves the profile, and dispatches to profileTrust', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-trust-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home, AGNES_PROFILE: 'enterprise' },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    const deployDir = join(home, 'deploy', 'xinwei')
    expect(await main(['profile', 'trust', deployDir], io)).toBe(0)
    expect(out).toBe(`trusted ${deployDir} (hash sha256-${'a'.repeat(64)}) for profile enterprise\n`)
    expect(trustFixture.calls).toEqual([
      {
        profile: 'enterprise',
        clientId: 'cli-client',
        commandId: expect.any(String),
        deployDir,
      },
    ])
    expect(trustFixture.closed).toBe(true)
  })

  it('resolves a relative deploy directory against cwd before dispatching to the client', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-trust-relative-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const io: MainIO = {
      env: { AGH_HOME: home, AGNES_PROFILE: 'enterprise' },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'trust', './deploy/xinwei'], io)).toBe(0)
    const expectedDeployDir = join(home, 'deploy/xinwei')
    expect(trustFixture.calls).toEqual([
      {
        profile: 'enterprise',
        clientId: 'cli-client',
        commandId: expect.any(String),
        deployDir: expectedDeployDir,
      },
    ])
  })

  it('resolves a relative deploy directory against an explicit --cwd flag, not the process cwd', async () => {
    // A real `agnes profile trust deploy/x --cwd <dir>` run surfaced this: the process's actual
    // cwd and the --cwd flag's value can differ, and only the flag should win (matching every
    // other command in bin.ts, e.g. the `package`/`doctor` --cwd handling).
    const home = mkdtempSync(join(tmpdir(), 'agnes-profile-trust-explicit-cwd-'))
    cleanup.push(home)
    const explicitCwd = mkdtempSync(join(tmpdir(), 'agnes-profile-trust-explicit-cwd-target-'))
    cleanup.push(explicitCwd)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const io: MainIO = {
      env: { AGH_HOME: home, AGNES_PROFILE: 'enterprise' },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'trust', './deploy/xinwei', '--cwd', explicitCwd], io)).toBe(0)
    const expectedDeployDir = join(explicitCwd, 'deploy/xinwei')
    expect(trustFixture.calls).toEqual([
      {
        profile: 'enterprise',
        clientId: 'cli-client',
        commandId: expect.any(String),
        deployDir: expectedDeployDir,
      },
    ])
  })

  it('resolves a relative --cwd against the invocation cwd before any command sees it', async () => {
    // A real `agnes --cwd . -p ...` run surfaced this: the raw "." reached the daemon, which resolved
    // it against its own working directory and answered WORKSPACE_INVALID; `sessions list --cwd .`
    // silently listed nothing for the same reason.
    const home = mkdtempSync(join(tmpdir(), 'agnes-relative-cwd-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const io: MainIO = {
      env: { AGH_HOME: home, AGNES_PROFILE: 'enterprise' },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr,
      cwd: home,
      agnesVersion: '0',
    }

    expect(await main(['profile', 'trust', './deploy/xinwei', '--cwd', 'target'], io)).toBe(0)
    expect(trustFixture.calls).toEqual([
      {
        profile: 'enterprise',
        clientId: 'cli-client',
        commandId: expect.any(String),
        deployDir: join(home, 'target', 'deploy/xinwei'),
      },
    ])
  })
})

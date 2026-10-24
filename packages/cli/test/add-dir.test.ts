import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAddDirs } from '../src/add-dir.js'
import { parseArgs } from '../src/args.js'
import { UsageError } from '../src/errors.js'
import { runPrint } from '../src/modes/print.js'
import type { Booted } from '../src/types.js'
import { FAKE_SESSION_ID, scriptedEndpoint } from './fake-endpoint.js'

const temps: string[] = []
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agh-add-dir-')))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('--add-dir parsing', () => {
  it('collects the repeatable flag in both spellings and leaves everything after -- alone', () => {
    const p = parseArgs([
      '--add-dir',
      '../lib',
      '--add-dir=/abs/other',
      '-p',
      'hello',
      '--',
      '--add-dir',
      'x',
    ])
    expect(p.addDir).toEqual(['../lib', '/abs/other'])
    expect(p.positional).toEqual(['hello', '--add-dir', 'x'])
  })

  it.each([
    [['--add-dir']],
    [['--add-dir', '--new']],
    [['--add-dir=']],
    [['doctor', '--add-dir', '/x']],
    [['resume', 'session-1', '--add-dir', '/x']],
    [Array.from({ length: 9 }, (_, i) => ['--add-dir', `/d${i}`]).flat()],
  ])('refuses %j', (argv) => {
    expect(() => parseArgs(argv as string[])).toThrow(UsageError)
  })
})

describe('--add-dir resolution', () => {
  const io = (cwd: string) => ({ cwd, env: {} as NodeJS.ProcessEnv })

  it('makes directories absolute against the working directory, once each', () => {
    const base = temp()
    mkdirSync(join(base, 'lib'))
    const p = parseArgs(['--add-dir', 'lib', '--add-dir', join(base, 'lib')])
    resolveAddDirs(p, 'tui', io(base), 'en')
    expect(p.addDir).toEqual([join(base, 'lib')])
  })

  it.each([
    ['--continue', ['--continue']],
    ['--resume', ['--resume', 'session-1']],
  ])('refuses to add directories to a resumed session (%s)', (_name, flags) => {
    const base = temp()
    const p = parseArgs(['--add-dir', base, ...flags])
    expect(() => resolveAddDirs(p, 'tui', io(base), 'en')).toThrow(/new session/)
  })

  it('refuses a missing directory, a file, and ACP', () => {
    const base = temp()
    writeFileSync(join(base, 'file.txt'), 'x')
    for (const bad of [join(base, 'missing'), join(base, 'file.txt')])
      expect(() => resolveAddDirs(parseArgs(['--add-dir', bad]), 'tui', io(base), 'en')).toThrow(
        /not an existing directory/,
      )
    expect(() => resolveAddDirs(parseArgs(['--add-dir', base]), 'acp', io(base), 'en')).toThrow(/ACP/)
  })

  it('does not check paths over --connect, but needs them absolute', () => {
    const base = temp()
    const p = parseArgs(['--connect', 'tok', '--add-dir', '/remote/only'])
    resolveAddDirs(p, 'tui', io(base), 'en')
    expect(p.addDir).toEqual(['/remote/only'])
    expect(() =>
      resolveAddDirs(parseArgs(['--connect', 'tok', '--add-dir', 'rel']), 'tui', io(base), 'en'),
    ).toThrow(UsageError)
  })
})

describe('--add-dir against a daemon (print mode)', () => {
  async function run(advertises: boolean, dirs: string[]) {
    const endpoint = scriptedEndpoint().on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: advertises ? { sessionCapabilities: { additionalDirectories: {} } } : {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    endpoint.on('session/new', () => ({ sessionId: FAKE_SESSION_ID }))
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    const booted: Booted = {
      client,
      profileName: 'local-dev',
      resolvedProfileHash: 'h',
      bootMs: 1,
      form: 'local',
      close: () => client.close(),
    }
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const stderr = new PassThrough()
    let err = ''
    stderr.on('data', (b: Buffer) => {
      err += String(b)
    })
    try {
      const pending = runPrint(booted, parseArgs(['-p', 'x', ...dirs.flatMap((d) => ['--add-dir', d])]), {
        stdout: new PassThrough(),
        stderr,
        stdin,
        cwd: '/w',
      }).then(
        (code) => ({ code, thrown: undefined as unknown }),
        (thrown: unknown) => ({ code: undefined, thrown }),
      )
      stdin.end('piped')
      const outcome = await pending
      return { ...outcome, calls: endpoint.calls, err }
    } finally {
      await client.close()
    }
  }

  it('registers each directory, then creates the session with the list', async () => {
    const r = await run(true, ['/lib/a', '/lib/b'])
    expect(r.code).toBe(0)
    const methods = r.calls.map((call) => call.method)
    const adds = r.calls
      .filter((call) => call.method === '_agnes/v1/workspace.add')
      .map((call) => call.params)
    expect(adds).toEqual([{ path: '/w' }, { path: '/lib/a' }, { path: '/lib/b' }])
    expect(methods.indexOf('session/new')).toBeGreaterThan(methods.lastIndexOf('_agnes/v1/workspace.add'))
    expect(r.calls.find((call) => call.method === 'session/new')?.params).toMatchObject({
      cwd: '/w',
      additionalDirectories: ['/lib/a', '/lib/b'],
    })
  })

  it('refuses an older daemon before registering anything or sending a prompt', async () => {
    const r = await run(false, ['/lib/a'])
    expect(r.thrown).toBeInstanceOf(UsageError)
    expect(String((r.thrown as Error).message)).toContain('does not support --add-dir')
    const methods = r.calls.map((call) => call.method)
    expect(methods).not.toContain('session/new')
    expect(methods).not.toContain('session/prompt')
    expect(r.calls.filter((call) => call.method === '_agnes/v1/workspace.add').map((c) => c.params)).toEqual([
      { path: '/w' },
    ])
  })
})

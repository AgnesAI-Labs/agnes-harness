import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { Host, HostSession } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { bootLocal, type LocalBootDeps } from '../src/boot/local.js'
import { say, TEST_LOCK, testDeps } from './boot-host.js'

const KEY = 'agnes:local:default:import:dm:admission-e2e'
const DENIED = { kind: 'json-rpc', data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } }

const tmp: string[] = []
afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const source = () =>
  new TextEncoder().encode(
    [
      { type: 'session', version: 3, id: 'admission-e2e', timestamp: '2026-09-07T00:00:00Z', cwd: '/old' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-09-07T00:00:01Z',
        message: { role: 'user', content: 'hello from import' },
      },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-09-07T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  )

/** Same Host wrapper as FAIL-003: the failOn-th Session.append rejects, then the real Host continues. */
function flakyHost(host: Host, failOn: number): Host {
  let appends = 0
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === 'createSession')
        return async (options: Parameters<Host['createSession']>[0]) => {
          const session = await target.createSession(options)
          return new Proxy(session, {
            get(st, sp, sr) {
              if (sp === 'append')
                return async (batch: Parameters<HostSession['append']>[0]) => {
                  appends += 1
                  if (appends === failOn) throw new Error('injected storage failure')
                  return st.append(batch)
                }
              const value = Reflect.get(st, sp, sr)
              return typeof value === 'function' ? value.bind(st) : value
            },
          })
        }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function ioFor(dir: string) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString()
  })
  const io: MainIO = {
    env: { AGH_HOME: dir, HOME: dir },
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '0',
  }
  return {
    io,
    out: () => out,
    err: () => err,
  }
}

async function runMain(
  dir: string,
  argv: string[],
  createHostImpl: NonNullable<LocalBootDeps['createHostImpl']>,
) {
  const captured = ioFor(dir)
  const code = await main(argv, captured.io, { lock: TEST_LOCK, createHostImpl })
  return { code, out: captured.out(), err: captured.err() }
}

function hostFactory(dir: string, failOn?: { n: number }) {
  return async () => {
    const { host } = await createTestHost({ dataDir: dir, script: [say('continued after import')] })
    return failOn ? flakyHost(host, failOn.n) : host
  }
}

describe('imported sessions survive a fresh local boot', () => {
  it('import then session/load, export, and --resume all succeed on a new process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-import-admit-e2e-'))
    tmp.push(dir)
    const file = join(dir, 'pi.jsonl')
    writeFileSync(file, source())
    const createHostImpl = hostFactory(dir)

    const imported = await runMain(dir, ['import', file, '--key', KEY], createHostImpl)
    expect(imported.code, imported.err).toBe(0)
    expect(imported.out).toContain(`imported 6 events into ${KEY}`)

    const booted = await bootLocal(parseArgs(['--resume', KEY]), testDeps(dir, { createHostImpl }))
    try {
      const session = await booted.client.session.load(KEY, { cwd: dir })
      expect(session.id).toBe(KEY)
      const continued = await session.prompt([{ type: 'text', text: 'go on' }])
      expect(continued.reason).toBe('completed')
    } finally {
      await booted.close()
    }

    const exported = await runMain(dir, ['export', KEY], createHostImpl)
    expect(exported.code, exported.err).toBe(0)
    expect(exported.out).toContain('hello from import')

    const resumed = await runMain(dir, ['--resume', KEY, '-p', 'go on'], createHostImpl)
    expect(resumed.code, resumed.err).toBe(0)
    expect(resumed.out).toContain('continued after import')
  }, 60_000)

  it('F01 rollback leaves the same key denied on a fresh boot until retry import activates it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-import-admit-f01-'))
    tmp.push(dir)
    const file = join(dir, 'pi.jsonl')
    writeFileSync(file, source())
    const failFirst = { n: 1 }

    const failed = await runMain(dir, ['import', file, '--key', KEY], hostFactory(dir, failFirst))
    expect(failed.code).toBe(1)
    expect(failed.err).toMatch(/rolled back and may be retried with the same key/)

    const deniedBoot = await bootLocal(
      parseArgs(['--resume', KEY]),
      testDeps(dir, { createHostImpl: hostFactory(dir) }),
    )
    try {
      await expect(deniedBoot.client.session.load(KEY, { cwd: dir })).rejects.toMatchObject(DENIED)
    } finally {
      await deniedBoot.close()
    }

    const deniedExport = await runMain(dir, ['export', KEY], hostFactory(dir))
    expect(deniedExport.code).toBe(1)
    expect(deniedExport.err).toMatch(/CAPABILITY_DENIED/)

    const deniedResume = await runMain(dir, ['--resume', KEY, '-p', 'go on'], hostFactory(dir))
    expect(deniedResume.code).toBe(1)
    expect(deniedResume.err).toMatch(/CAPABILITY_DENIED/)

    const retried = await runMain(dir, ['import', file, '--key', KEY], hostFactory(dir))
    expect(retried.code, retried.err).toBe(0)
    expect(retried.out).toContain(`imported 6 events into ${KEY}`)

    const admitted = await bootLocal(
      parseArgs(['--resume', KEY]),
      testDeps(dir, { createHostImpl: hostFactory(dir) }),
    )
    try {
      const session = await admitted.client.session.load(KEY, { cwd: dir })
      expect(session.id).toBe(KEY)
      const continued = await session.prompt([{ type: 'text', text: 'go on' }])
      expect(continued.reason).toBe('completed')
    } finally {
      await admitted.close()
    }

    const exported = await runMain(dir, ['export', KEY], hostFactory(dir))
    expect(exported.code, exported.err).toBe(0)
    expect(exported.out).toContain('hello from import')

    const resumed = await runMain(dir, ['--resume', KEY, '-p', 'go on'], hostFactory(dir))
    expect(resumed.code, resumed.err).toBe(0)
    expect(resumed.out).toContain('continued after import')
  }, 60_000)
})

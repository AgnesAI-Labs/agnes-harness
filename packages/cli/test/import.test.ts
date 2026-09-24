import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { importSession } from '@agnes/bridges/convert'
import { createTestHost } from '@agnes/host/testkit'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { importBatches, importFile } from '../src/commands/import.js'
import { UsageError } from '../src/errors.js'
import { TEST_LOCK } from './boot-host.js'
import { memoryAdmission, openAdmittedSession } from './import-admission.js'

const source = (id = 'pi-cli') =>
  new TextEncoder().encode(
    [
      { type: 'session', version: 3, id, timestamp: '2026-09-07T00:00:00Z', cwd: '/old' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-09-07T00:00:01Z',
        message: { role: 'user', content: 'hello' },
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

const sink = () => {
  let value = ''
  return {
    io: {
      stdout: { write: (chunk: string | Uint8Array) => (value += chunk.toString()) },
      stderr: { write: (_chunk: string | Uint8Array) => undefined },
    },
    value: () => value,
  }
}

describe('import command', () => {
  it('is dispatched by the executable through a local Host', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-import-main-'))
    const file = join(home, 'pi.jsonl')
    writeFileSync(file, source())
    const stdout = new PassThrough()
    let output = ''
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr: new PassThrough(),
      cwd: home,
      agnesVersion: '0',
    }
    try {
      await expect(
        main(['import', file], io, {
          lock: TEST_LOCK,
          createHostImpl: async () => (await createTestHost({ dataDir: home })).host,
        }),
      ).resolves.toBe(0)
      expect(output).toContain('imported 6 events into agnes:local:default:import:dm:pi-cli')
      const exported = await main(['export', 'agnes:local:default:import:dm:pi-cli'], io, {
        lock: TEST_LOCK,
        createHostImpl: async () => (await createTestHost({ dataDir: home })).host,
      })
      expect(exported).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('converts into a fresh host session and writes only complete turn transactions', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-import-'))
    const { host } = await createTestHost({ dataDir })
    const output = sink()
    const admission = await memoryAdmission(host, dataDir)
    const key = 'agnes:local:default:import:dm:pi-cli'
    try {
      await expect(
        importFile(parseArgs(['import', 'input.jsonl']), {
          env: {},
          cwd: dataDir,
          host,
          admission,
          io: output.io,
          readFile: () => source(),
        }),
      ).resolves.toBe(0)
      expect(output.value()).toMatch(/imported 6 events into agnes:local:default:import:dm:pi-cli/)
      const session = await openAdmittedSession(host, admission, key, dataDir)
      try {
        const events = await session.scan({ limit: 20 })
        expect(events.map((event) => event.type)).toEqual([
          'session/start',
          'turn/start',
          'user/message',
          'step/start',
          'assistant/message',
          'step/end',
          'turn/end',
        ])
        expect(events.slice(1).every((event) => event.trust === 'untrusted')).toBe(true)
      } finally {
        await session.close()
      }
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['claude-code/basic.jsonl', 'abc'],
    ['codex/basic.jsonl', 'sess-1'],
  ] as const)('appends the complete %s conversion through core relation checks', async (name, id) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-import-source-'))
    const { host } = await createTestHost({ dataDir })
    const bytes = readFileSync(new URL(`../../bridges/fixtures/import/${name}`, import.meta.url))
    const key = `agnes:local:default:import:dm:${id}`
    const admission = await memoryAdmission(host, dataDir)
    try {
      await expect(
        importFile(parseArgs(['import', 'input.jsonl']), {
          env: {},
          cwd: dataDir,
          host,
          admission,
          io: sink().io,
          readFile: () => bytes,
        }),
      ).resolves.toBe(0)
      const session = await openAdmittedSession(host, admission, key, dataDir)
      try {
        const events = await session.scan({ limit: 100 })
        expect(events.some((event) => event.type === 'tool/call')).toBe(true)
        expect(events.some((event) => event.type === 'tool/result')).toBe(true)
        expect(events.at(-1)?.type).toBe('turn/end')
      } finally {
        await session.close()
      }
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('honors an explicit key and refuses either remote-connect spelling before reading', async () => {
    let reads = 0
    const deps = {
      env: {},
      cwd: '/w',
      host: {} as never,
      admission: {} as never,
      io: sink().io,
      readFile: () => {
        reads++
        return source()
      },
    }
    await expect(importFile(parseArgs(['import', 'x', '--connect', 'unix:/s']), deps)).rejects.toBeInstanceOf(
      UsageError,
    )
    await expect(
      importFile(parseArgs(['import', 'x']), {
        ...deps,
        env: { AGNES_CONNECT: 'ws://localhost' },
      }),
    ).rejects.toBeInstanceOf(UsageError)
    expect(reads).toBe(0)
  })

  it('packs at closed-turn boundaries and refuses a single oversized turn', () => {
    const row = (type: string): Omit<EventEnvelope, 'seq'> =>
      ({
        ts: new Date(0).toISOString(),
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type,
        data: {},
        actor: { id: 'i', org: 'l', role: 'r', deptPath: [], attrs: {} },
        origin: 'import:pi',
        trust: 'untrusted',
      }) as Omit<EventEnvelope, 'seq'>
    const events = [
      ...Array.from({ length: 499 }, () => row('x/agnes/import/unmapped')),
      row('turn/start'),
      row('user/message'),
      row('turn/end'),
    ]
    expect(importBatches(events).map((batch) => batch.length)).toEqual([499, 3])
    expect(() =>
      importBatches([
        row('turn/start'),
        ...Array.from({ length: 499 }, () => row('user/message')),
        row('turn/end'),
      ]),
    ).toThrow(/exceeding batch limit/)
  })

  it('refuses to append an import to a target that already holds a conversation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-import-existing-'))
    const { host } = await createTestHost({ dataDir })
    const deps = {
      env: {},
      cwd: dataDir,
      host,
      admission: await memoryAdmission(host, dataDir),
      io: sink().io,
    }
    try {
      await expect(
        importFile(parseArgs(['import', 'input.jsonl', '--key', 'occupied']), {
          ...deps,
          readFile: () => source('first'),
        }),
      ).resolves.toBe(0)
      await expect(
        importFile(parseArgs(['import', 'input.jsonl', '--key', 'occupied']), {
          ...deps,
          readFile: () => source('other'),
        }),
      ).rejects.toThrow(/not fresh/)
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // Opening a session runs its session_start hooks, and code-mode records `x/agnes/code-mode/kernel`
  // there. The stand-in below does the same unless the opener asks for no hooks, which import must:
  // a row at seq 2 would put a native stream's body off the sequence numbers its rows point at.
  it('opens its target without session_start hooks, so both kinds of source land at seq 2', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-import-hooked-'))
    const { host } = await createTestHost({ dataDir })
    const hooked = {
      createSession: async (opts: Parameters<typeof host.createSession>[0]) => {
        const session = await host.createSession(opts)
        if (!opts.skipSessionStartHooks)
          await session.append([
            {
              type: 'x/agnes/code-mode/kernel',
              data: { alive: false },
              actor: session.d.actor,
              origin: 'system',
              trust: 'trusted',
              ignorable: true,
            },
          ])
        return session
      },
    } as unknown as typeof host
    const native = new TextEncoder().encode(
      importSession(source('native'), { from: 'pi' })
        .events.map((event) => JSON.stringify(event))
        .join('\n'),
    )
    const admission = await memoryAdmission(host, dataDir)
    const run = (key: string, bytes: Uint8Array) =>
      importFile(parseArgs(['import', 'input.jsonl', '--key', key]), {
        env: {},
        cwd: dataDir,
        host: hooked,
        admission,
        io: sink().io,
        readFile: () => bytes,
      })
    try {
      await expect(run('hooked', source())).resolves.toBe(0)
      await expect(run('hooked-native', native)).resolves.toBe(0)
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // An export taken before chunks were kept has a hole wherever one was streamed; every row after it
  // would land one sequence early. Refused before a target is even opened, with what to do instead.
  it('refuses a native stream with a sequence hole before opening a target', async () => {
    const rows = importSession(source('holed'), { from: 'pi' }).events
    const holed = rows.map((event, index) => (index < 2 ? event : { ...event, seq: event.seq + 1 }))
    let opened = 0
    await expect(
      importFile(parseArgs(['import', 'old.jsonl', '--key', 'holed']), {
        env: {},
        cwd: tmpdir(),
        host: { createSession: async () => void opened++ } as never,
        admission: {
          reserve: async () => {
            throw new Error('must not reserve a holed native import')
          },
          activate: () => {
            throw new Error('must not activate a holed native import')
          },
        },
        io: sink().io,
        readFile: () => new TextEncoder().encode(holed.map((event) => JSON.stringify(event)).join('\n')),
      }),
    ).rejects.toThrow(/old\.jsonl line 3: .*does not follow.*re-export/)
    expect(opened).toBe(0)
  })

  it('names --key when the target session is held by another writer', async () => {
    const held = {
      createSession: async () => {
        throw Object.assign(new Error('E_WRITER_LEASE: session held by another writer'), {
          code: 'E_WRITER_LEASE',
        })
      },
    } as unknown as Parameters<typeof importFile>[1]['host']
    await expect(
      importFile(parseArgs(['import', 'input.jsonl']), {
        env: {},
        cwd: tmpdir(),
        host: held,
        admission: {
          reserve: async () => ({ binding: {} as never, reservedNew: true }),
          activate: () => undefined,
        },
        io: sink().io,
        readFile: () => source(),
      }),
    ).rejects.toThrow(/--key/)
  })
})

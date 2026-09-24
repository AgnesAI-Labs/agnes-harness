import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { say, TEST_LOCK } from './boot-host.js'

function run(dir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const io: MainIO = {
    env: { AGH_HOME: dir, HOME: dir },
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: () => undefined,
  }
  return main(argv, io, {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir, script: [say('first answer')] })).host,
  }).then((code) => ({ code, out, err }))
}

// Native rows point at each other by sequence number (sourceEventSeqs, requestSeq, ...), so an agnes
// export only imports back if every row lands on the sequence it was exported with. The export has to
// carry its assistant/output rows to have no holes, and the target must hold nothing but session/start.
describe('agnes export -> import round trip', () => {
  it('lands every exported row on its own sequence number, through core relation checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-roundtrip-'))
    const file = join(dir, 'session.jsonl')
    try {
      const turn = await run(dir, ['-p', 'hello', '--mode', 'json'])
      expect(turn.code, turn.err).toBe(0)
      const { sessionId } = JSON.parse(turn.out) as { sessionId: string }

      const exported = await run(dir, ['export', sessionId, '-o', file])
      expect(exported.code, exported.err).toBe(0)
      const rows = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as EventEnvelope)
      expect(rows.map((event) => event.seq)).toEqual(rows.map((_event, index) => index + 1))
      expect(rows.some((event) => event.type === 'assistant/output')).toBe(true)
      expect(rows.some((event) => event.type === 'request/sent')).toBe(true)
      // The program counter is a register cell: no row of it is exported, and its marks are.
      expect(rows.some((event) => event.type === 'op.state')).toBe(false)
      expect(rows.some((event) => event.type === 'x/core/op-mark')).toBe(true)

      const imported = await run(dir, ['import', file, '--key', 'restored'])
      expect(imported.code, imported.err).toBe(0)

      const { host } = await createTestHost({ dataDir: dir })
      try {
        const restored = await host.createSession({ key: 'restored', cwd: dir })
        const shape = (event: EventEnvelope) => [event.seq, event.type, event.sourceEventSeqs ?? null]
        const landed = await restored.scan({ toSeq: rows.length })
        expect(landed.slice(1).map(shape)).toEqual(rows.slice(1).map(shape))
        await restored.close()
      } finally {
        await host.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an export that still carries the removed assistant/chunk rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-roundtrip-old-'))
    const file = join(dir, 'session.jsonl')
    try {
      const turn = await run(dir, ['-p', 'hello', '--mode', 'json'])
      expect(turn.code, turn.err).toBe(0)
      const { sessionId } = JSON.parse(turn.out) as { sessionId: string }
      expect((await run(dir, ['export', sessionId, '-o', file])).code).toBe(0)
      // What an older build exported: the output start marker was a streamed chunk row.
      const rows = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as EventEnvelope)
      const old = rows.map((event) =>
        event.type === 'assistant/output'
          ? { ...event, type: 'assistant/chunk', data: { kind: 'text', delta: 'hello', effectId: 'e1' } }
          : event,
      )
      writeFileSync(file, `${old.map((event) => JSON.stringify(event)).join('\n')}\n`)
      const imported = await run(dir, ['import', file, '--key', 'restored-old'])
      expect(imported.code).not.toBe(0)
      expect(imported.err).toContain('an agnes export must keep every row')
      expect(imported.err).toContain('this export comes from an older format')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an export that still carries the removed op.state rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-roundtrip-op-'))
    const file = join(dir, 'session.jsonl')
    try {
      const turn = await run(dir, ['-p', 'hello', '--mode', 'json'])
      expect(turn.code, turn.err).toBe(0)
      const { sessionId } = JSON.parse(turn.out) as { sessionId: string }
      expect((await run(dir, ['export', sessionId, '-o', file])).code).toBe(0)
      // What an older build exported: the program counter as a row where an op-mark now stands.
      const rows = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as EventEnvelope)
      const old = rows.map((event) =>
        event.type === 'x/core/op-mark'
          ? { ...event, type: 'op.state', register: 'op.state', ignorable: undefined, data: null }
          : event,
      )
      writeFileSync(file, `${old.map((event) => JSON.stringify(event)).join('\n')}\n`)
      const imported = await run(dir, ['import', file, '--key', 'restored-op'])
      expect(imported.code).not.toBe(0)
      expect(imported.err).toContain('an agnes export must keep every row')
      expect(imported.err).toContain('this export comes from an older format')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

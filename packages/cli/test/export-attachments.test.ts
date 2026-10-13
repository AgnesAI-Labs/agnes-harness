import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Readable } from 'node:stream'
import { createAttachmentStore } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { EventEnvelope, HarnessMeta } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { exportSession } from '../src/commands/export.js'
import { say, TEST_LOCK } from './boot-host.js'
import { FakeEndpoint } from './fake-endpoint.js'

const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const MIB = 1024 * 1024

/** A 1x1 PNG: valid enough for a reference image, small enough to read in one window. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

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
    createHostImpl: async () =>
      (
        await createTestHost({
          dataDir: dir,
          script: [say('first answer')],
          storeAttachmentsByReference: true,
        })
      ).host,
  }).then((code) => ({ code, out, err }))
}

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => ({ line, event: JSON.parse(line) as EventEnvelope }))

describe('agh export and attachments, against a real session', () => {
  it('exports old inline rows as stored, and the bytes of referenced attachments beside a raw export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-export-attach-'))
    try {
      const turn = await run(dir, ['-p', 'hello', '--mode', 'json'])
      expect(turn.code, turn.err).toBe(0)
      const { sessionId } = JSON.parse(turn.out) as { sessionId: string }

      // An old 20 MiB inline file, and an image uploaded by reference.
      const big = randomBytes(20 * MIB)
      const store = createAttachmentStore({ dataDir: dir })
      const image = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      await store.markUserAttachment(image, { mimeType: 'image/png', receiptFor: sessionId })
      const { host } = await createTestHost({ dataDir: dir, storeAttachmentsByReference: true })
      let inlineSeq = 0
      let refSeq = 0
      try {
        const session = await host.createSession({ key: sessionId, cwd: dir })
        const user = (content: unknown[]) => ({
          actor: ACTOR,
          origin: 'principal' as const,
          trust: 'trusted' as const,
          type: 'user/message' as const,
          data: { content },
        })
        await session.append([
          user([
            { type: 'file', mimeType: 'application/zip', name: 'big.zip', data: big.toString('base64') },
          ]),
        ] as never)
        inlineSeq = session.lastSeq
        await session.append([
          user([
            {
              type: 'image',
              mimeType: 'image/png',
              name: 'dot.png',
              attachment: { sha256: image.sha256, bytes: image.bytes },
              width: 1,
              height: 1,
            },
          ]),
        ] as never)
        refSeq = session.lastSeq
        await session.close()
      } finally {
        await host.close()
      }

      const file = join(dir, 'x.jsonl')
      const exported = await run(dir, ['export', sessionId, '--raw', '--out', file])
      expect(exported.code, exported.err).toBe(0)
      const rows = lines(file)
      const db = new DatabaseSync(join(dir, 'sessions.db'), { readOnly: true })
      try {
        const stored = db
          .prepare('SELECT data FROM events WHERE session_key = ? AND seq = ?')
          .get(sessionId, inlineSeq) as { data: string }
        const row = rows.find((r) => r.event.seq === inlineSeq)
        expect(JSON.stringify(row?.event.data) === stored.data).toBe(true)
      } finally {
        db.close()
      }
      const copy = join(`${file}.attachments`, image.sha256)
      expect(sha(readFileSync(copy))).toBe(image.sha256)
      expect(readdirSync(`${file}.attachments`)).toEqual([image.sha256])

      const redacted = join(dir, 'y.jsonl')
      expect((await run(dir, ['export', sessionId, '--out', redacted])).code).toBe(0)
      const plain = lines(redacted)
      const content = (seq: number) =>
        (plain.find((r) => r.event.seq === seq)?.event.data as { content?: unknown[] } | undefined)?.content
      expect(content(inlineSeq)).toEqual([
        { type: 'file', mimeType: 'application/zip', name: 'big.zip', data: '[OMITTED:file:base64]' },
      ])
      expect(content(refSeq)).toEqual([
        {
          type: 'image',
          mimeType: 'image/png',
          name: 'dot.png',
          attachment: { sha256: image.sha256, bytes: image.bytes },
          width: 1,
          height: 1,
        },
      ])
      expect(existsSync(`${redacted}.attachments`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

// What a worker-hosted session replays: a large old inline attachment in the lean form.
const SESSION_ID = 'agnes:local:default:cli:dm:lean'
const FULL_DATA = randomBytes(3 * MIB).toString('base64')
const ROW_1 = {
  seq: 1,
  ts: new Date(0).toISOString(),
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type: 'user/message',
  data: { content: [{ type: 'file', mimeType: 'application/zip', name: 'old.zip', data: FULL_DATA }] },
  actor: ACTOR,
  origin: 'principal',
  trust: 'trusted',
}
const STORED_LINE = `${JSON.stringify(ROW_1)}\n`
const LEAN_1 = {
  ...ROW_1,
  data: {
    content: [
      { type: 'file', mimeType: 'application/zip', name: 'old.zip', dataOmitted: { bytes: 3 * MIB } },
    ],
  },
}
const ORIGINAL = randomBytes(MIB + 100)
const THUMB = randomBytes(500)
const REF_ROW = {
  seq: 2,
  ts: new Date(0).toISOString(),
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAC',
  type: 'user/message',
  data: {
    content: [
      { type: 'text', text: 'see' },
      {
        type: 'image',
        mimeType: 'image/png',
        attachment: { sha256: sha(ORIGINAL), bytes: ORIGINAL.byteLength },
        width: 10,
        height: 10,
        thumbnail: { sha256: sha(THUMB), bytes: THUMB.byteLength, width: 10, height: 10 },
      },
    ],
  },
  actor: ACTOR,
  origin: 'principal',
  trust: 'trusted',
}

function leanEndpoint(o: { original?: Buffer } = {}): FakeEndpoint {
  const events = [LEAN_1, REF_ROW]
  const original = o.original ?? ORIGINAL
  const line = Buffer.from(STORED_LINE)
  const PIECE = 2 * MIB
  return new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: 'test' } },
    }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.verifyHistory', () => ({}))
    .on('_agnes/v1/session.attach', (_params, ep) => {
      for (const event of events) {
        const meta: HarnessMeta = {
          promptTurnId: 'turn-export',
          eventSequence: event.seq,
          generation: 1,
          lane: 'main',
          phase: 'event',
        }
        ep.pushEvent(SESSION_ID, event, meta)
      }
      return { generation: 1, lastSeq: 2, resolvedProfileHash: null }
    })
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: SESSION_ID,
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.exportRaw', (params) => {
      const { seq, offset } = params as { seq: number; offset: number }
      expect(seq).toBe(1)
      const end = Math.min(line.byteLength, offset + PIECE)
      return {
        seq,
        base64: line.subarray(offset, end).toString('base64'),
        nextOffset: end < line.byteLength ? end : null,
      }
    })
    .on('_agnes/v1/session.attachmentRead', (params) => {
      const p = params as {
        seq: number
        kind: string
        index: number
        offset: number
        length: number
        thumbnail?: boolean
      }
      expect(p).toMatchObject({ sessionId: SESSION_ID, seq: 2, kind: 'image', index: 1 })
      const bytes = p.thumbnail ? THUMB : original
      return {
        mimeType: 'image/png',
        totalBytes: bytes.byteLength,
        base64: bytes.subarray(p.offset, p.offset + p.length).toString('base64'),
      }
    })
}

async function leanClient(ep: FakeEndpoint) {
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep }, journal: memoryJournal() })
  await client.initialize()
  return client
}

describe('agh export --raw of a session whose replay is lean', () => {
  it('puts every lean row back whole through session.exportRaw and writes each referenced object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-export-lean-'))
    const ep = leanEndpoint()
    const client = await leanClient(ep)
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      const out = join(dir, 'x.jsonl')
      await exportSession(parseArgs(['export', SESSION_ID, '--raw', '--out', out]), { cwd: dir, io }, client)
      const [first, second] = readFileSync(out, 'utf8').split('\n')
      expect(`${first}\n`).toBe(STORED_LINE)
      expect(JSON.parse(second ?? '')).toEqual(REF_ROW)
      expect(ep.calls.filter((c) => c.method === '_agnes/v1/session.exportRaw')).toHaveLength(
        Math.ceil(Buffer.byteLength(STORED_LINE) / (2 * MIB)),
      )
      expect(sha(readFileSync(join(`${out}.attachments`, sha(ORIGINAL))))).toBe(sha(ORIGINAL))
      expect(sha(readFileSync(join(`${out}.attachments`, sha(THUMB))))).toBe(sha(THUMB))
      const windows = ep.calls.filter((c) => c.method === '_agnes/v1/session.attachmentRead')
      expect(windows.map((c) => (c.params as { length: number }).length)).toEqual([MIB, 100, 500])

      // A second export into the same place keeps the copies it can prove and reads nothing again.
      const again = leanEndpoint()
      const another = await leanClient(again)
      try {
        await exportSession(
          parseArgs(['export', SESSION_ID, '--raw', '--out', out]),
          { cwd: dir, io },
          another,
        )
      } finally {
        await another.close()
      }
      expect(again.calls.some((c) => c.method === '_agnes/v1/session.attachmentRead')).toBe(false)
    } finally {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops, and writes no rows, when an attachment does not match its reference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-export-lean-bad-'))
    const client = await leanClient(leanEndpoint({ original: randomBytes(ORIGINAL.byteLength) }))
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      const out = join(dir, 'x.jsonl')
      await expect(
        exportSession(parseArgs(['export', SESSION_ID, '--raw', '--out', out]), { cwd: dir, io }, client),
      ).rejects.toThrow(/does not match its reference/)
      expect(existsSync(out)).toBe(false)
      expect(readdirSync(`${out}.attachments`)).toEqual([])
    } finally {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a redacted export as replayed: lean blocks and references keep their metadata only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-export-lean-plain-'))
    const ep = leanEndpoint()
    const client = await leanClient(ep)
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } }
    try {
      const out = join(dir, 'x.jsonl')
      await exportSession(parseArgs(['export', SESSION_ID, '--out', out]), { cwd: dir, io }, client)
      const [first, second] = readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as EventEnvelope)
      expect(first?.data).toEqual(LEAN_1.data)
      expect((second?.data as { content?: unknown[] } | undefined)?.content?.[1]).toEqual(
        REF_ROW.data.content[1],
      )
      expect(
        ep.calls.some((c) =>
          ['_agnes/v1/session.exportRaw', '_agnes/v1/session.attachmentRead'].includes(c.method),
        ),
      ).toBe(false)
      expect(existsSync(`${out}.attachments`)).toBe(false)
    } finally {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

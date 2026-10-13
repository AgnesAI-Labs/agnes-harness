import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Readable } from 'node:stream'
import { createAttachmentStore } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { say, TEST_LOCK } from './boot-host.js'

const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ZIP = Buffer.from('PK\u0003\u0004 an archive uploaded by reference')
const SHA = createHash('sha256').update(ZIP).digest('hex')

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

/** A raw export of a session whose last row references an uploaded file; returns the export path. */
async function exportedWithReference(dir: string): Promise<{ file: string; refSeq: number }> {
  const turn = await run(dir, ['-p', 'hello', '--mode', 'json'])
  expect(turn.code, turn.err).toBe(0)
  const { sessionId } = JSON.parse(turn.out) as { sessionId: string }
  const store = createAttachmentStore({ dataDir: dir })
  const object = await store.put(ZIP, { kind: 'user-attachment', mimeType: 'application/zip' })
  await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: sessionId })
  const { host } = await createTestHost({ dataDir: dir, storeAttachmentsByReference: true })
  let refSeq = 0
  try {
    const session = await host.createSession({ key: sessionId, cwd: dir })
    await session.append([
      {
        actor: ACTOR,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: {
          content: [
            {
              type: 'file',
              mimeType: 'application/zip',
              name: 'a.zip',
              attachment: { sha256: SHA, bytes: ZIP.byteLength },
            },
          ],
        },
      },
    ] as never)
    refSeq = session.lastSeq
    await session.close()
  } finally {
    await host.close()
  }
  const file = join(dir, 'session.jsonl')
  const exported = await run(dir, ['export', sessionId, '--raw', '--out', file])
  expect(exported.code, exported.err).toBe(0)
  return { file, refSeq }
}

const rowsOf = (dir: string, key: string) => {
  if (!existsSync(join(dir, 'sessions.db'))) return 0
  const db = new DatabaseSync(join(dir, 'sessions.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_key = ?').get(key) as { n: number }).n
  } finally {
    db.close()
  }
}

describe('agh import of rows that reference attachments', () => {
  it('brings the bytes from the export, so the imported session reads them on another installation', async () => {
    const source = mkdtempSync(join(tmpdir(), 'agnes-import-attach-src-'))
    const target = mkdtempSync(join(tmpdir(), 'agnes-import-attach-dst-'))
    try {
      const { file, refSeq } = await exportedWithReference(source)
      const copy = join(target, 'session.jsonl')
      cpSync(file, copy)
      cpSync(`${file}.attachments`, `${copy}.attachments`, { recursive: true })

      const imported = await run(target, ['import', copy, '--key', 'restored'])
      expect(imported.code, imported.err).toBe(0)
      const store = createAttachmentStore({ dataDir: target })
      expect(await store.userAttachment(SHA)).toMatchObject({ bytes: ZIP.byteLength, receipts: [] })

      const { host } = await createTestHost({ dataDir: target })
      try {
        const session = await host.createSession({ key: 'restored', cwd: target })
        const window = await session.readAttachmentRange({
          seq: refSeq,
          kind: 'file',
          index: 1,
          offset: 0,
          length: 1024,
        })
        expect(Buffer.from(window.bytes)).toEqual(ZIP)
        await session.close()
      } finally {
        await host.close()
      }
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses, writing nothing, a reference whose bytes it does not bring or that do not match', async () => {
    const source = mkdtempSync(join(tmpdir(), 'agnes-import-attach-src-'))
    const target = mkdtempSync(join(tmpdir(), 'agnes-import-attach-dst-'))
    try {
      const { file } = await exportedWithReference(source)
      const copy = join(target, 'session.jsonl')
      cpSync(file, copy)

      const missing = await run(target, ['import', copy, '--key', 'missing'])
      expect(missing.code).not.toBe(0)
      expect(missing.err).toContain(`attachment ${SHA} is neither in`)
      expect(rowsOf(target, 'missing')).toBe(0)

      cpSync(`${file}.attachments`, `${copy}.attachments`, { recursive: true })
      // Same size, other bytes: only the digest tells them apart.
      writeFileSync(join(`${copy}.attachments`, SHA), Buffer.alloc(ZIP.byteLength, 0x41))
      const wrong = await run(target, ['import', copy, '--key', 'wrong'])
      expect(wrong.code).not.toBe(0)
      expect(wrong.err).toContain('is not the attachment the rows name')
      expect(rowsOf(target, 'wrong')).toBe(0)
      expect(await createAttachmentStore({ dataDir: target }).stat(SHA)).toBeUndefined()

      // On the installation that holds the bytes, the export imports without its directory.
      rmSync(`${file}.attachments`, { recursive: true, force: true })
      const local = await run(source, ['import', file, '--key', 'local-copy'])
      expect(local.code, local.err).toBe(0)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  }, 60_000)
})

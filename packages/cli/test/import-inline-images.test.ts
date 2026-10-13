import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Readable } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { say, TEST_LOCK } from './boot-host.js'

/** A 1x1 PNG, imported as an inline image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const DATA = PNG.toString('base64')

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
    // Storage by reference on, as in a default profile: imported rows still keep their images inline.
    createHostImpl: async () =>
      (await createTestHost({ dataDir: dir, script: [say('unused')], storeAttachmentsByReference: true }))
        .host,
  }).then((code) => ({ code, out, err }))
}

const SOURCES = {
  'claude-code': [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/w',
      sessionId: 'cc-images',
      version: '2.1.88',
      timestamp: '2026-10-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } },
        ],
      },
    },
  ],
  pi: [
    { type: 'session', version: 3, id: 'pi-images', timestamp: '2026-10-01T00:00:00Z', cwd: '/w' },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-10-01T00:00:01Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', data: DATA, mimeType: 'image/png' },
        ],
      },
    },
  ],
} as const

describe('imported inline images', () => {
  it.each(Object.keys(SOURCES) as Array<keyof typeof SOURCES>)(
    'from %s are written to the ledger as they are, listed and read back',
    async (source) => {
      const dir = mkdtempSync(join(tmpdir(), `agnes-import-images-${source}-`))
      try {
        const file = join(dir, `${source}.jsonl`)
        writeFileSync(file, `${SOURCES[source].map((row) => JSON.stringify(row)).join('\n')}\n`)
        const key = `agnes:local:default:import:dm:${source}-images`
        const imported = await run(dir, ['import', file, '--from', source, '--key', key])
        expect(imported.code, imported.err).toBe(0)

        // No queue-time conversion: the image stays inline, and the session stays at the old format.
        const db = new DatabaseSync(join(dir, 'sessions.db'), { readOnly: true })
        let seq = 0
        try {
          const rows = db
            .prepare("SELECT seq, data FROM events WHERE session_key = ? AND type = 'user/message'")
            .all(key) as Array<{ seq: number; data: string }>
          const withImage = rows.find((row) => row.data.includes('"type":"image"'))
          expect(withImage?.data).toContain(`"data":"${DATA}"`)
          expect(withImage?.data).not.toContain('"attachment"')
          seq = withImage?.seq ?? 0
          const format = db.prepare('SELECT format_version FROM sessions WHERE session_key = ?').get(key) as {
            format_version: number
          }
          expect(format.format_version).toBe(1)
        } finally {
          db.close()
        }

        const { host } = await createTestHost({ dataDir: dir, storeAttachmentsByReference: true })
        try {
          const session = await host.createSession({ key, cwd: dir })
          // What `read session-image://list` lists: the session's attachment index.
          const listed = session.attachmentIndex
            .list('image', session.lane)
            .map((entry) => `session-image://${entry.seq}/${entry.index}`)
          expect(listed).toEqual([`session-image://${seq}/1`])
          const window = await session.readAttachmentRange({
            seq,
            kind: 'image',
            index: 1,
            offset: 0,
            length: 1024 * 1024,
          })
          expect(window.mimeType).toBe('image/png')
          expect(Buffer.from(window.bytes)).toEqual(PNG)
          await session.close()
        } finally {
          await host.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})

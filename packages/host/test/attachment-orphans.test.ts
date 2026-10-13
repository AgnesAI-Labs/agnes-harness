import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Lets one case write a ledger row while the collection holds the ledger lock, right before it
// verifies the roots: the row a session appends between the unlocked catch-up and the locked proof.
const hook = vi.hoisted(() => ({
  beforeVerify: undefined as ((ledger: DatabaseSync) => unknown) | undefined,
}))
vi.mock('../src/artifact-ref-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/artifact-ref-index.js')>()
  return {
    ...actual,
    verifyRootsUnderLedgerLock: async (input: Parameters<typeof actual.verifyRootsUnderLedgerLock>[0]) => {
      await hook.beforeVerify?.(input.ledger)
      return actual.verifyRootsUnderLedgerLock(input)
    },
  }
})

const { DDL } = await import('../src/adapters/ddl.js')
const { collectAttachmentOrphans, restoreSetAsideAttachments, scheduleAttachmentOrphans } = await import(
  '../src/attachment-orphans.js'
)
const { attachmentReceiptFor, createAttachmentStore } = await import('../src/attachment-store.js')
const { createPrivateArtifactStore } = await import('../src/private-artifact-store.js')
const { createUserAttachmentPort } = await import('../src/user-attachments.js')

const DAY = 24 * 60 * 60 * 1000
const GRACE = 7 * DAY
const T = 1_800_000_000_000
const dirs: string[] = []

afterEach(() => {
  hook.beforeVerify = undefined
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dataDir = resolve(mkdtempSync(join(tmpdir(), 'agh-orphans-')))
  dirs.push(dataDir)
  const db = new DatabaseSync(join(dataDir, 'sessions.db'))
  for (const statement of DDL) db.exec(statement)
  let now = T
  const store = createAttachmentStore({ dataDir, clock: () => now })
  const seqs = new Map<string, number>()
  const row = (sessionKey: string, type: string, data: unknown, ledger: DatabaseSync = db) => {
    const seq = (seqs.get(sessionKey) ?? 0) + 1
    seqs.set(sessionKey, seq)
    if (seq === 1)
      ledger
        .prepare('INSERT OR IGNORE INTO sessions (session_key, created_at) VALUES (?, ?)')
        .run(sessionKey, new Date(T).toISOString())
    ledger
      .prepare(
        `INSERT INTO events (session_key, seq, ts, id, type, actor, origin, trust, data)
         VALUES (?, ?, ?, ?, ?, '{}', 'principal', 'trusted', ?)`,
      )
      .run(sessionKey, seq, new Date(now).toISOString(), `${sessionKey}-${seq}`, type, JSON.stringify(data))
  }
  const object = async (text: string, at: number, mimeType = 'application/octet-stream') => {
    now = at
    const stored = await store.put(new TextEncoder().encode(text), { kind: 'user-attachment', mimeType })
    await store.markUserAttachment(stored, { mimeType })
    now = T
    return stored
  }
  const reference = (sessionKey: string, sha256: string, bytes: number) =>
    row(sessionKey, 'user/message', {
      content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', attachment: { sha256, bytes } }],
    })
  const present = (sha256: string) => ({
    bytes: existsSync(join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256)),
    marker: existsSync(
      join(dataDir, 'artifacts', 'user-attachment-meta', sha256.slice(0, 2), `${sha256}.json`),
    ),
  })
  const collect = (at = T, signal?: AbortSignal) =>
    collectAttachmentOrphans({
      dataDir,
      store,
      graceMs: GRACE,
      clock: () => at,
      ...(signal ? { signal } : {}),
    })
  const setNow = (at: number) => {
    now = at
  }
  return { dataDir, db, store, row, object, reference, present, collect, setNow }
}

describe('collecting unreferenced user attachments', () => {
  it('deletes only what nothing references and nobody has seen for the grace period', async () => {
    const f = fixture()
    const a = await f.object('referenced', T - 8 * DAY)
    const b = await f.object('forgotten', T - 8 * DAY)
    const c = await f.object('recent', T - 1 * DAY)
    f.reference('s1', a.sha256, a.bytes)

    expect(await f.collect()).toEqual({ deleted: 1, bytes: b.bytes })
    expect(f.present(b.sha256)).toEqual({ bytes: false, marker: false })
    expect(f.present(a.sha256)).toEqual({ bytes: true, marker: true })
    expect(f.present(c.sha256)).toEqual({ bytes: true, marker: true })
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
  })

  it('keeps bytes stored or marked again within the grace period, as an upload of the same bytes does', async () => {
    const f = fixture()
    const b = await f.object('uploaded twice', T - 8 * DAY)
    const again = await f.object('uploaded twice', T - 1 * DAY)
    expect(again.sha256).toBe(b.sha256)
    expect((await f.store.userAttachment(b.sha256))?.lastSeenMs).toBe(T - 1 * DAY)
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    expect(f.present(b.sha256)).toEqual({ bytes: true, marker: true })
    // A receipt added by an upload is a rewrite, and counts as seen too.
    const d = await f.object('receipt later', T - 8 * DAY)
    f.setNow(T - 2 * DAY)
    await f.store.markUserAttachment(d, { mimeType: 'application/zip', receiptFor: 'agnes:s9' })
    f.setNow(T)
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    expect(await f.collect(T + 6 * DAY)).toEqual({ deleted: 1, bytes: d.bytes })
    expect(await f.collect(T + 7 * DAY)).toEqual({ deleted: 1, bytes: b.bytes })
  })

  it('collects a referenced attachment once its session is gone and its grace has passed', async () => {
    const f = fixture()
    const a = await f.object('in a session that will be deleted', T)
    f.reference('gone', a.sha256, a.bytes)
    expect(await f.collect(T + 8 * DAY)).toEqual({ deleted: 0, bytes: 0 })
    f.db.prepare('DELETE FROM events WHERE session_key = ?').run('gone')
    f.db.prepare('DELETE FROM sessions WHERE session_key = ?').run('gone')
    expect(await f.collect(T + 1 * DAY)).toEqual({ deleted: 0, bytes: 0 })
    expect(await f.collect(T + 8 * DAY)).toEqual({ deleted: 1, bytes: a.bytes })
    expect(f.present(a.sha256)).toEqual({ bytes: false, marker: false })
  })

  it('treats a live session cache of old inline attachments as a root, and drops the cache of a gone session', async () => {
    const f = fixture()
    const kept = await f.object('cached copy of a live session', T - 8 * DAY)
    const dropped = await f.object('cached copy of a gone session', T - 8 * DAY)
    f.row('live', 'user/message', { content: [{ type: 'text', text: 'hi' }] })
    const cache = join(f.dataDir, 'artifacts', 'user-attachment-cache')
    mkdirSync(cache, { recursive: true })
    const map = (sessionKey: string, sha256: string, bytes: number) => {
      const path = join(cache, `${attachmentReceiptFor(sessionKey)}.json`)
      writeFileSync(path, JSON.stringify({ '2/file/1': { sha256, bytes, rowId: 'r' } }))
      utimesSync(path, new Date(T - 8 * DAY), new Date(T - 8 * DAY))
      return path
    }
    const liveMap = map('live', kept.sha256, kept.bytes)
    const goneMap = map('gone', dropped.sha256, dropped.bytes)
    expect(await f.collect()).toEqual({ deleted: 1, bytes: dropped.bytes })
    expect(f.present(kept.sha256)).toEqual({ bytes: true, marker: true })
    expect(existsSync(liveMap)).toBe(true)
    expect(existsSync(goneMap)).toBe(false)
  })

  it('never sweeps an upload a send has authorized and not yet written (authorize, sweep, append)', async () => {
    const f = fixture()
    const draft = await f.object('a draft uploaded long ago', T - 8 * DAY)
    f.setNow(T - 8 * DAY)
    await f.store.markUserAttachment(draft, { mimeType: 'application/zip', receiptFor: 's1' })
    f.setNow(T)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'earlier' }] })
    const port = createUserAttachmentPort({ store: f.store, limits: {}, storeByReference: true })
    const verdict = await port.authorize({
      sha256: draft.sha256,
      bytes: draft.bytes,
      mimeType: 'application/zip',
      sessionKey: 's1',
      referenced: false,
    })
    expect(verdict).toBe('ok')
    // The sweep runs before the admitted row is appended.
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    f.reference('s1', draft.sha256, draft.bytes)
    expect(f.present(draft.sha256)).toEqual({ bytes: true, marker: true })
  })

  it('puts bytes back when their marker is refreshed after they were set aside', async () => {
    const f = fixture()
    const b = await f.object('sent while being swept', T - 8 * DAY)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    let reads = 0
    // The sender's touch lands just after the sweep's last look before setting the bytes aside.
    const store = {
      ...f.store,
      userAttachment: async (sha256: string) => {
        const marker = await f.store.userAttachment(sha256)
        if (sha256 === b.sha256 && ++reads === 2)
          await f.store.markUserAttachment(b, { mimeType: 'application/octet-stream' })
        return marker
      },
    }
    expect(
      await collectAttachmentOrphans({ dataDir: f.dataDir, store, graceMs: GRACE, clock: () => T }),
    ).toEqual({ deleted: 0, bytes: 0 })
    expect(reads).toBe(3)
    expect(f.present(b.sha256)).toEqual({ bytes: true, marker: true })
    expect(await f.store.read(b.sha256)).toEqual(new TextEncoder().encode('sent while being swept'))
  })

  it('restores bytes a crashed run had set aside', async () => {
    const f = fixture()
    const b = await f.object('set aside by a crashed run', T)
    const objectPath = join(f.dataDir, 'artifacts', 'sha256', b.sha256.slice(0, 2), b.sha256)
    const aside = join(f.dataDir, 'artifacts', 'sweeping')
    mkdirSync(aside, { recursive: true })
    renameSync(objectPath, join(aside, `${b.sha256}.0b7c6f1e-0000-4000-8000-000000000000`))
    expect(f.present(b.sha256).bytes).toBe(false)
    await f.collect()
    expect(f.present(b.sha256)).toEqual({ bytes: true, marker: true })
    expect(readdirSync(aside)).toEqual([])
  })

  it('never restores bytes another run has set aside and is still deciding about', async () => {
    const f = fixture()
    const b = await f.object('swept by two runs at once', T - 8 * DAY)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    let reads = 0
    let second: Promise<unknown> | undefined
    // Run A has set the bytes aside and is about to judge the marker again when run B starts, as a
    // second worker process's daily run would.
    const store = {
      ...f.store,
      userAttachment: async (sha256: string) => {
        if (sha256 === b.sha256 && ++reads === 3) {
          second = f.collect().then(
            (result) => result,
            (error: unknown) => error,
          )
          await new Promise((done) => setTimeout(done, 200))
        }
        return f.store.userAttachment(sha256)
      },
    }
    const first = await collectAttachmentOrphans({
      dataDir: f.dataDir,
      store,
      graceMs: GRACE,
      clock: () => T,
    })
    expect(first).toEqual({ deleted: 1, bytes: b.bytes })
    expect(await second).toEqual({ deleted: 0, bytes: 0 })
    // Bytes and marker went together: no object is left behind without the marker that collects it.
    expect(f.present(b.sha256)).toEqual({ bytes: false, marker: false })
    expect(readdirSync(join(f.dataDir, 'artifacts', 'sweeping'))).toEqual([])
  })

  it('puts set-aside bytes back only once the run that set them aside has decided', async () => {
    const f = fixture()
    const b = await f.object('restored at a start meanwhile', T - 8 * DAY)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    let reads = 0
    let restoring: Promise<boolean> | undefined
    let early: { bytes: boolean; marker: boolean } | undefined
    // A host starting while a run has the bytes aside puts back what it finds there.
    const store = {
      ...f.store,
      userAttachment: async (sha256: string) => {
        if (sha256 === b.sha256 && ++reads === 3) {
          restoring = restoreSetAsideAttachments({ dataDir: f.dataDir, root: f.store.root })
          await new Promise((done) => setTimeout(done, 200))
          early = f.present(b.sha256)
        }
        return f.store.userAttachment(sha256)
      },
    }
    expect(
      await collectAttachmentOrphans({ dataDir: f.dataDir, store, graceMs: GRACE, clock: () => T }),
    ).toEqual({ deleted: 1, bytes: b.bytes })
    expect(early).toEqual({ bytes: false, marker: true })
    expect(await restoring).toBe(true)
    expect(f.present(b.sha256)).toEqual({ bytes: false, marker: false })
  })

  it('keeps an object uploaded again while the run was deciding', async () => {
    const f = fixture()
    const b = await f.object('uploaded again meanwhile', T - 8 * DAY)
    const other = await f.object('really forgotten', T - 8 * DAY)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    hook.beforeVerify = () => {
      hook.beforeVerify = undefined
      // The same bytes uploaded again after the candidates were read: the marker is seen now.
      return f.object('uploaded again meanwhile', T)
    }
    expect(await f.collect()).toEqual({ deleted: 1, bytes: other.bytes })
    expect(f.present(b.sha256)).toEqual({ bytes: true, marker: true })
  })

  it('keeps an object a session names in a row written just before the locked proof', async () => {
    const f = fixture()
    const b = await f.object('referenced meanwhile', T - 8 * DAY)
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'first' }] })
    hook.beforeVerify = (ledger) => {
      hook.beforeVerify = undefined
      // The collection holds the write lock; this is the row a session appended just before it.
      f.row(
        's1',
        'inbox',
        {
          items: [
            {
              content: [
                {
                  type: 'file',
                  mimeType: 'application/zip',
                  attachment: { sha256: b.sha256, bytes: b.bytes },
                },
              ],
            },
          ],
        },
        ledger,
      )
    }
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    expect(f.present(b.sha256)).toEqual({ bytes: true, marker: true })
  })

  it('never deletes bytes the artifacts seam or a request also uses', async () => {
    const f = fixture()
    const linked = await f.object('linked from a tool result', T - 8 * DAY)
    const media = await f.object('sent as request media', T - 8 * DAY)
    const thumb = await f.object('a thumbnail', T - 8 * DAY)
    f.row('s1', 'tool/result', {
      content: [
        { type: 'resource_link', uri: `artifact://${linked.sha256}`, name: 'x', mimeType: 'image/png' },
      ],
    })
    f.row('s1', 'request/header', {
      media: {
        manifest: [{ sha256: media.sha256, artifactUri: `artifact://${media.sha256}`, mime: 'image/png' }],
      },
    })
    f.row('s1', 'user/message', {
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          attachment: { sha256: 'f'.repeat(64), bytes: 1 },
          width: 1,
          height: 1,
          thumbnail: { sha256: thumb.sha256, bytes: thumb.bytes, width: 1, height: 1 },
        },
      ],
    })
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    for (const object of [linked, media, thumb])
      expect(f.present(object.sha256)).toEqual({ bytes: true, marker: true })
  })

  it('leaves bytes that are also a screenshot to the screenshot collection', async () => {
    const f = fixture()
    const shot = await f.object('screenshot bytes', T - 8 * DAY)
    const store = createPrivateArtifactStore(f.dataDir, process.platform === 'win32' ? 'win32' : 'darwin')
    await store.putComputerUseMetadata(
      shot.sha256,
      new TextEncoder().encode(
        `${JSON.stringify({ schemaVersion: 1, sha256: shot.sha256, size: shot.bytes, createdAtMs: T })}\n`,
      ),
    )
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    expect(f.present(shot.sha256)).toEqual({ bytes: true, marker: false })
  })

  it('deletes nothing without a ledger, when the run is aborted, or for an object that is not a user attachment', async () => {
    const f = fixture()
    const b = await f.object('forgotten', T - 8 * DAY)
    const plain = new TextEncoder().encode('an ordinary artifact')
    const plainSha = createHash('sha256').update(plain).digest('hex')
    await f.store.put(plain, { kind: 'request-version', mimeType: 'image/png' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await f.collect(T, aborted.signal)).toEqual({ deleted: 0, bytes: 0 })
    // Aborted while the ledger lock is held: the proof is dropped and nothing is deleted.
    f.row('s1', 'user/message', { content: [{ type: 'text', text: 'no reference' }] })
    const closing = new AbortController()
    hook.beforeVerify = () => {
      hook.beforeVerify = undefined
      closing.abort()
    }
    expect(await f.collect(T, closing.signal)).toEqual({ deleted: 0, bytes: 0 })
    expect(f.present(b.sha256).bytes).toBe(true)
    f.db.close()
    rmSync(join(f.dataDir, 'sessions.db'))
    expect(await f.collect()).toEqual({ deleted: 0, bytes: 0 })
    expect(f.present(b.sha256).bytes).toBe(true)
    expect(f.present(plainSha).bytes).toBe(true)
  })

  it('runs once a day, first five minutes after start, and stops on close', async () => {
    // Only the timers are faked: a run's file reads must still finish between the ticks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const settle = async () => {
      for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done))
    }
    const runs: number[] = []
    const store = {
      root: join(tmpdir(), 'agh-orphans-nowhere'),
    } as unknown as Parameters<typeof scheduleAttachmentOrphans>[0]['store']
    const scheduled = scheduleAttachmentOrphans({
      dataDir: store.root,
      store: new Proxy(store, {
        get: (target, key) => (key === 'root' ? target.root : undefined),
      }),
      graceMs: GRACE,
      clock: () => {
        runs.push(Date.now())
        return Date.now()
      },
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(runs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toHaveLength(1)
    await settle()
    await vi.advanceTimersByTimeAsync(DAY)
    expect(runs).toHaveLength(2)
    scheduled.close()
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(runs).toHaveLength(2)
  })
})

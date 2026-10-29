import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Event } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { validateAgainst } from '@agnes/protocol'
import { SessionViewResult } from '@agnes/protocol/gen/agnes-v1'
import { expect, it, vi } from 'vitest'
import {
  readSessionView,
  readStoredSessionView,
  type SessionRowsReader,
} from '../../src/runtime/sessions/session-view.js'
import { createTestHost } from '../../testkit/index.js'

function rows(count: number): Event[] {
  const out: Event[] = []
  const push = (type: string, data: Event['data']) => {
    const seq = out.length + 1
    out.push({
      seq,
      ts: new Date(Date.UTC(2026, 9, 12, 0, 0, seq)).toISOString(),
      id: `01K0000000000000000000${String(seq).padStart(4, '0')}`,
      type,
      data,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
    })
  }
  for (let turn = 1; out.length < count; turn += 1) {
    push('user/message', { content: [{ type: 'text', text: `question ${turn}` }] })
    push('turn/start', { turn, trigger: 'prompt' })
    push('turn/end', { reason: 'completed', lastAssistantSeq: null })
  }
  return out
}

/** A reader over fixed rows that fails the way a damaged or foreign ledger does at one row. */
const readerOf =
  (all: Event[], failAt?: { seq: number; code: string }): SessionRowsReader =>
  async (_key, { fromSeq = 1, toSeq = Number.POSITIVE_INFINITY, limit, order = 'asc' }) => {
    const inRange = all.filter((row) => row.seq >= fromSeq && row.seq <= toSeq)
    const page = (order === 'desc' ? inRange.reverse() : inRange).slice(0, limit)
    if (failAt && page.some((row) => row.seq === failAt.seq))
      throw new HostError(failAt.code as never, `ledger ${failAt.code}`)
    return page
  }

it('projects a whole ledger read-only and never reports a running operation', async () => {
  const view = await readSessionView(readerOf(rows(9)), 'quiet')
  expect(view).toMatchObject({ sessionId: 'quiet', readOnly: true, lastSeq: 9 })
  expect(view.notice).toBeUndefined()
  expect(view.timeline.opState).toBeNull()
  expect(view.timeline.turns.length).toBeGreaterThan(0)
  expect(view.timeline.turns.every((turn) => !turn.forkable)).toBe(true)
  expect(view.timeline.nodes.filter((node) => node.kind === 'user')).toHaveLength(3)
  expect(validateAgainst(SessionViewResult, view).ok).toBe(true)
})

it('windows long histories and says there is earlier history', async () => {
  const view = await readSessionView(readerOf(rows(1500)), 'long', { maxNodes: 10 })
  expect(view.timeline.nodes).toHaveLength(10)
  expect(view.history).toMatchObject({ hasEarlier: true, totalNodes: 500, startIndex: 490 })
})

it.each([
  ['E_FORMAT_NEWER', 'newer', 'E_SESSION_VERSION_NEWER', ['upgrade']],
  ['E_FORMAT_OLDER', 'older', 'E_SESSION_VERSION_OLDER', ['new-session']],
] as const)(
  'a %s ledger still reads what decodes and says why with a localized notice',
  async (code, issue, notice, actions) => {
    const view = await readSessionView(readerOf(rows(6), { seq: 4, code }), 's-1')
    expect(view.notice).toMatchObject({ code: notice, issue, actions })
    expect(view.notice?.localized['zh-CN']).toContain('你')
    expect(view.notice?.localized.en).toContain('s-1')
    // A page that cannot be decoded is dropped whole; nothing after it is guessed.
    expect(view.lastSeq).toBe(0)
    expect(validateAgainst(SessionViewResult, view).ok).toBe(true)
  },
)

it.each(['E_FORMAT_CORRUPT', 'E_LEDGER_INTEGRITY'])(
  'keeps rows before a corrupt page and reports %s',
  async (code) => {
    const all = rows(1200)
    const reader: SessionRowsReader = async (key, query) => {
      if ((query.fromSeq ?? 1) > 500) throw new HostError(code as never, 'row 501 failed')
      return readerOf(all)(key, query)
    }
    const view = await readSessionView(reader, 'damaged')
    expect(view.lastSeq).toBe(500)
    expect(view.timeline.nodes.length).toBeGreaterThan(0)
    expect(view.notice).toMatchObject({
      code: 'E_SESSION_CORRUPT',
      issue: 'corrupt',
      actions: ['new-session'],
    })
  },
)

it('treats a gap in the sequence as corruption instead of skipping it', async () => {
  const all = rows(9).filter((row) => row.seq !== 5)
  const view = await readSessionView(readerOf(all), 'gap')
  expect(view.lastSeq).toBe(4)
  expect(view.notice?.issue).toBe('corrupt')
})

it('does not swallow a failure that is not about the record itself', async () => {
  const reader: SessionRowsReader = async () => {
    throw new Error('disk offline')
  }
  await expect(readSessionView(reader, 'x')).rejects.toThrow('disk offline')
})

it('shows the newest rows when the event budget is smaller than the session', async () => {
  const view = await readSessionView(readerOf(rows(1500)), 'huge', { budget: { events: 600 } })
  expect(view.history.scan).toEqual({ reason: 'events', fromSeq: 901, throughSeq: 1500 })
  expect(view.lastSeq).toBe(1500)
  expect(view.timeline.nodes.filter((node) => node.kind === 'user').at(-1)).toBeDefined()
  expect(validateAgainst(SessionViewResult, view).ok).toBe(true)
})

it('counts the whole encoded event against the byte budget and keeps the newest rows', async () => {
  const view = await readSessionView(readerOf(rows(1500)), 'heavy', { budget: { bytes: 2000 } })
  expect(view.history.scan?.reason).toBe('bytes')
  expect(view.history.scan?.throughSeq).toBe(1500)
  expect(view.lastSeq - (view.history.scan?.fromSeq ?? 0)).toBeLessThan(20)
})

it('stops at once when the caller cancels', async () => {
  const cancelled = new AbortController()
  let reads = 0
  const reader: SessionRowsReader = async (key, query) => {
    reads += 1
    cancelled.abort()
    return readerOf(rows(1500))(key, query)
  }
  const view = await readSessionView(reader, 'gone', { signal: cancelled.signal })
  expect(reads).toBe(1)
  expect(view.history.scan?.reason).toBe('cancelled')
})

it('abandons a read that never returns at its deadline and at the caller cancel', async () => {
  const hung: SessionRowsReader = () => new Promise<Event[]>(() => undefined)
  const late = await readSessionView(hung, 'hung', { budget: { timeMs: 20 } })
  expect(late.history.scan?.reason).toBe('time')
  const cancelled = new AbortController()
  const pending = readSessionView(hung, 'hung', { signal: cancelled.signal })
  setTimeout(() => cancelled.abort(), 10)
  expect((await pending).history.scan?.reason).toBe('cancelled')
})

it('keeps the readable newer rows when an older page cannot be decoded', async () => {
  const view = await readSessionView(readerOf(rows(1500), { seq: 800, code: 'E_FORMAT_CORRUPT' }), 'broken', {
    budget: { events: 600 },
  })
  expect(view.notice?.issue).toBe('corrupt')
  expect(view.lastSeq).toBe(1500)
})

it('reports no scan marker when the whole history fits', async () => {
  const view = await readSessionView(readerOf(rows(9)), 'small')
  expect(view.history.scan).toBeUndefined()
})

/** A storage adapter over fixed rows; `lean` adds the lean page read the SQLite adapter has. */
function storageOf(all: Event[], lean: boolean) {
  const read = vi.fn(readerOf(all))
  return {
    read,
    storage: lean
      ? {
          scan: vi.fn(async () => {
            throw new Error('a lean read must not fall back to full rows')
          }),
          scanLean: read,
        }
      : { scan: read },
  }
}

it.each([
  ['lean pages', true],
  ['full rows', false],
])('reads a stored view from %s with the preview budget', async (_name, lean) => {
  const all = rows(2600)
  const { read, storage } = storageOf(all, lean)
  const view = await readStoredSessionView(storage, 'stored', { maxNodes: 10 })
  expect(read).toHaveBeenCalled()
  // The preview budget, not the full scan budget: the newest 2000 rows.
  expect(view.history.scan).toEqual({ reason: 'events', fromSeq: all.length - 1999, throughSeq: all.length })
  expect(view.timeline.nodes).toHaveLength(10)
})

it('keeps oversized text and media out of a stored view', async () => {
  const all = rows(3)
  all[0] = {
    ...(all[0] as Event),
    data: {
      content: [
        { type: 'text', text: 'x'.repeat(20_000) },
        { type: 'image', data: 'a'.repeat(1000), mimeType: 'image/png' },
      ],
    },
  }
  const view = await readStoredSessionView(storageOf(all, true).storage, 'heavy')
  const shown = JSON.stringify(view.timeline.nodes)
  expect(shown).toContain('[Unverified preview truncated]')
  expect(shown).toContain('[Original media omitted from unverified preview]')
  expect(shown).not.toContain('x'.repeat(16_385))
})

it('passes the caller cancel to a stored view', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  const { read, storage } = storageOf(rows(9), true)
  const view = await readStoredSessionView(storage, 'gone', { signal: cancelled.signal })
  // At most the newest-row probe starts; no page of history is read.
  expect(read.mock.calls.length).toBeLessThanOrEqual(1)
  expect(view.history.scan?.reason).toBe('cancelled')
})

it('gives a Host the same view a stored read gives', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-stored-view-'))
  const { host } = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    script: [
      [
        { type: 'text_delta', delta: 'stored reply' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  try {
    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'show me' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const hosted = await host.readSessionView(session.key, { maxNodes: 50 })
    expect(hosted.timeline.nodes.some((node) => node.kind === 'assistant')).toBe(true)
    expect(await readStoredSessionView(host.kernel.o.storage, session.key, { maxNodes: 50 })).toEqual(hosted)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

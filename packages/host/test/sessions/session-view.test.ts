import type { Event } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import { validateAgainst } from '@agnes/protocol'
import { SessionViewResult } from '@agnes/protocol/gen/agnes-v1'
import { expect, it } from 'vitest'
import { readSessionView, type SessionRowsReader } from '../../src/runtime/sessions/session-view.js'

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
  async (_key, { fromSeq = 1, limit }) => {
    if (failAt && fromSeq <= failAt.seq && failAt.seq < fromSeq + limit)
      throw new HostError(failAt.code as never, `ledger ${failAt.code}`)
    return all.filter((row) => row.seq >= fromSeq).slice(0, limit)
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

it('keeps the rows before a corrupt page and reports corruption', async () => {
  const all = rows(1200)
  const reader: SessionRowsReader = async (key, query) => {
    if ((query.fromSeq ?? 1) > 500) throw new HostError('E_FORMAT_CORRUPT' as never, 'row 501 failed')
    return readerOf(all)(key, query)
  }
  const view = await readSessionView(reader, 'damaged')
  expect(view.lastSeq).toBe(500)
  expect(view.timeline.nodes.length).toBeGreaterThan(0)
  expect(view.notice).toMatchObject({ code: 'E_SESSION_CORRUPT', issue: 'corrupt', actions: ['new-session'] })
})

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

it('stops a scan at its event budget and says how far it got', async () => {
  const view = await readSessionView(readerOf(rows(1500)), 'huge', { budget: { events: 600 } })
  expect(view.history.scan).toEqual({ reason: 'events', throughSeq: 1000 })
  expect(view.lastSeq).toBe(1000)
  expect(validateAgainst(SessionViewResult, view).ok).toBe(true)
})

it('stops a scan at its byte budget and when the caller cancels', async () => {
  const bytes = await readSessionView(readerOf(rows(1500)), 'heavy', { budget: { bytes: 1 } })
  expect(bytes.history.scan?.reason).toBe('bytes')
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

it('reports no scan marker when the whole history fits', async () => {
  const view = await readSessionView(readerOf(rows(9)), 'small')
  expect(view.history.scan).toBeUndefined()
})

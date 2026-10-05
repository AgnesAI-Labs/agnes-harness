/** @vitest-environment happy-dom */
import type { UINode, UITurn } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import {
  activeConversationCut,
  type ConversationCutView,
  createConversationCutBanner,
  createConversationCutView,
  cutConversationNodes,
  cutConversationTurns,
} from '../src/conversation-cut.js'

afterEach(() => vi.useRealTimers())

const node = (value: Record<string, unknown>): UINode => value as unknown as UINode
const turn = (value: Record<string, unknown>): UITurn => value as unknown as UITurn

it('keeps only nodes the ledger had committed at the cut and reopens tools settled later', () => {
  const user = node({ kind: 'user', id: 'u', seq: 1 })
  const settled = node({
    kind: 'tool',
    id: 't1',
    seq: 5,
    resultSeq: 6,
    resultPreview: 'done',
    status: 'completed',
  })
  const pendingAtCut = node({
    kind: 'tool',
    id: 't2',
    seq: 5,
    resultSeq: 9,
    resultPreview: 'late',
    status: 'completed',
  })
  const slot = node({ kind: 'slot', id: 's', fill: { slot: 'tool.card.inline', extId: 'x' } })
  const later = node({ kind: 'assistant', id: 'a2', seq: 12, text: 'future' })
  const kept = cutConversationNodes([user, settled, pendingAtCut, slot, later], 7)
  expect(kept.map((value) => value.id)).toEqual(['u', 't1', 't2', 's'])
  expect(kept[1]).toBe(settled)
  const reopened = kept[2] as Extract<UINode, { kind: 'tool' }>
  expect(reopened.status).toBe('running')
  expect(reopened.resultSeq).toBeUndefined()
  expect(reopened.resultPreview).toBeUndefined()
  expect((pendingAtCut as Extract<UINode, { kind: 'tool' }>).status).toBe('completed')
})

it('drops turns that begin after the cut and reopens the turn spanning it', () => {
  const done = turn({ id: 'one', startSeq: 1, endSeq: 8, status: 'completed' })
  const spanning = turn({
    id: 'two',
    startSeq: 9,
    endSeq: 30,
    endedAt: '2026-10-05T00:00:05Z',
    durationMs: 5000,
    reason: 'completed',
    status: 'completed',
  })
  const future = turn({ id: 'three', startSeq: 31, status: 'running' })
  const kept = cutConversationTurns([done, spanning, future], 12)
  expect(kept.map((value) => value.id)).toEqual(['one', 'two'])
  expect(kept[0]).toBe(done)
  const reopened = kept[1]!
  expect(reopened.status).toBe('running')
  expect(reopened.endSeq).toBeUndefined()
  expect(reopened.endedAt).toBeUndefined()
  expect(reopened.durationMs).toBeUndefined()
  expect(reopened.reason).toBeUndefined()
  expect(cutConversationTurns(undefined, 12)).toEqual([])
})

it('resolves the active cut per session', () => {
  expect(activeConversationCut({ sessionId: 's1', through: 4 }, 's1')).toBe(4)
  expect(activeConversationCut({ sessionId: 's1', through: 4 }, 's2')).toBeUndefined()
  expect(activeConversationCut(undefined, 's1')).toBeUndefined()
  expect(activeConversationCut({ sessionId: 's1', through: 4 }, undefined)).toBeUndefined()
})

it('shows and clears the conversation cut banner', () => {
  const host = document.createElement('div')
  const banner = createConversationCutBanner(host)
  expect(host.querySelector<HTMLParagraphElement>('p.conversation-cut-banner')?.hidden).toBe(true)
  banner.update(9)
  const element = host.querySelector<HTMLParagraphElement>('p.conversation-cut-banner')!
  expect(element.hidden).toBe(false)
  expect(element.textContent).toContain('#9')
  expect(element.title).toBe(element.textContent)
  expect(element.textContent).toContain('实时')
  banner.update(9, true)
  expect(element.textContent).toContain('正在读取')
  banner.update(10, true, false, 9)
  expect(element.textContent).toContain('当前显示已确认的 #9')
  banner.update(9, false, true)
  expect(element.textContent).toContain('失败')
  banner.update(undefined)
  expect(element.hidden).toBe(true)
  expect(element.title).toBe('')
  banner.dispose()
  expect(host.querySelector('p.conversation-cut-banner')).toBeNull()
})

it('never renders the live window while the fixed cut is pending, then paints the faithful projection', async () => {
  vi.useFakeTimers()
  const views: Array<ConversationCutView | undefined> = []
  const cut = createConversationCutView((view) => views.push(view))
  const hands: Array<{
    resolve(value: { nodes: UINode[]; turns: UITurn[] }): void
    reject(reason?: unknown): void
  }> = []
  const projectAt = vi.fn(
    () =>
      new Promise<{ nodes: UINode[]; turns: UITurn[] }>((resolve, reject) => {
        hands.push({ resolve, reject })
      }),
  )
  // An early-born assistant node whose loaded text was finalized after the cut, plus a later
  // node: nothing from the live window may render until the projection at the cut arrives.
  const earlyBorn = node({ kind: 'assistant', id: 'a', seq: 2, text: 'text appended after the cut' })
  cut.apply(10, { projectAt })
  expect(views.at(-1)).toMatchObject({ through: 10, pending: true, nodes: [], turns: [] })
  expect((views.at(-1) as ConversationCutView).nodes).toEqual([])
  vi.advanceTimersByTime(200)
  expect(projectAt).toHaveBeenCalledWith(10)
  hands[0]!.resolve({
    nodes: [earlyBorn, node({ kind: 'user', id: 'faithful', seq: 1 })],
    turns: [turn({ id: 't', startSeq: 1, status: 'running' })],
  })
  await vi.waitFor(() => expect(views.at(-1)).toMatchObject({ through: 10, pending: false }))
  const verified = views.at(-1) as ConversationCutView
  expect(verified.nodes.map((value) => value.id)).toEqual(['a', 'faithful'])
  // Same seq with a settled view is a no-op; it must not refetch or repaint.
  const before = views.length
  cut.apply(10, { projectAt })
  expect(views.length).toBe(before)
  // Clearing returns the conversation to live without a fetch.
  cut.apply(undefined, { projectAt })
  expect(views.at(-1)).toBeUndefined()
})

it('drops stale projections and surfaces a failed read as an empty error view, never future content', async () => {
  vi.useFakeTimers()
  const views: Array<ConversationCutView | undefined> = []
  const cut = createConversationCutView((view) => views.push(view))
  const hands: Array<{
    resolve(value: { nodes: UINode[]; turns: UITurn[] }): void
    reject(reason?: unknown): void
  }> = []
  const projectAt = vi.fn(
    () =>
      new Promise<{ nodes: UINode[]; turns: UITurn[] }>((resolve, reject) => {
        hands.push({ resolve, reject })
      }),
  )
  cut.apply(3, { projectAt })
  vi.advanceTimersByTime(200)
  cut.apply(8, { projectAt })
  vi.advanceTimersByTime(200)
  expect(projectAt).toHaveBeenCalledTimes(1)
  // A valid older projection stays visible while the newest cut catches up.
  hands[0]!.resolve({ nodes: [node({ kind: 'user', id: 'stale', seq: 1 })], turns: [] })
  await Promise.resolve()
  expect(views.at(-1)).toMatchObject({ through: 8, projectedThrough: 3, pending: true })
  expect((views.at(-1) as ConversationCutView).nodes[0]?.id).toBe('stale')
  vi.advanceTimersByTime(200)
  expect(projectAt).toHaveBeenCalledTimes(2)
  hands[1]!.resolve({ nodes: [node({ kind: 'user', id: 'fresh', seq: 1 })], turns: [] })
  await vi.waitFor(() => expect(views.at(-1)).toMatchObject({ through: 8, pending: false }))
  expect((views.at(-1) as ConversationCutView).nodes[0]?.id).toBe('fresh')
  // A failing authoritative read empties the view and marks the error instead of keeping
  // anything the live window already holds.
  cut.apply(11, { projectAt })
  expect(views.at(-1)).toMatchObject({ through: 11, pending: true })
  vi.advanceTimersByTime(200)
  hands[2]!.reject(new Error('offline'))
  await Promise.resolve()
  await Promise.resolve()
  expect(views.at(-1)).toMatchObject({ through: 11, pending: false, error: true, nodes: [], turns: [] })
  expect(cut.view?.error).toBe(true)
  // Dispose cancels a pending read and restores live.
  cut.apply(13, { projectAt })
  cut.dispose()
  expect(views.at(-1)).toBeUndefined()
  vi.advanceTimersByTime(1000)
  expect(projectAt).toHaveBeenCalledTimes(3)
  expect(cut.view).toBeUndefined()
})

it('starts reading during rapid playback and never shows a projection from after a backward seek', async () => {
  vi.useFakeTimers()
  const views: Array<ConversationCutView | undefined> = []
  const cut = createConversationCutView((view) => views.push(view))
  const hands: Array<(value: { nodes: UINode[]; turns: UITurn[] }) => void> = []
  const projectAt = vi.fn(
    () =>
      new Promise<{ nodes: UINode[]; turns: UITurn[] }>((resolve) => {
        hands.push(resolve)
      }),
  )
  cut.apply(1, { projectAt })
  vi.advanceTimersByTime(100)
  cut.apply(2, { projectAt })
  vi.advanceTimersByTime(100)
  cut.apply(3, { projectAt })
  expect(projectAt).toHaveBeenCalledTimes(1)
  expect(projectAt).toHaveBeenCalledWith(2)
  hands[0]!({ nodes: [node({ kind: 'user', id: 'step-2', seq: 2 })], turns: [] })
  await Promise.resolve()
  expect(views.at(-1)).toMatchObject({ through: 3, projectedThrough: 2, pending: true })
  vi.advanceTimersByTime(200)
  expect(projectAt).toHaveBeenCalledWith(3)
  cut.apply(1, { projectAt })
  expect(views.at(-1)).toMatchObject({ through: 1, pending: true, nodes: [] })
  hands[1]!({ nodes: [node({ kind: 'user', id: 'future', seq: 3 })], turns: [] })
  await Promise.resolve()
  expect(views.at(-1)).toMatchObject({ through: 1, pending: true, nodes: [] })
  vi.advanceTimersByTime(200)
  expect(projectAt).toHaveBeenCalledWith(1)
  hands[2]!({ nodes: [node({ kind: 'user', id: 'step-1', seq: 1 })], turns: [] })
  await Promise.resolve()
  expect((views.at(-1) as ConversationCutView).nodes[0]?.id).toBe('step-1')
  cut.dispose()
})

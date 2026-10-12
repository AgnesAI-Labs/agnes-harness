/** @vitest-environment happy-dom */
import type { AdminFeedbackResult, FeedbackItem } from '@agnes/protocol/gen/app-server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  invalidateSessionFeedback,
  loadSessionFeedback,
  subscribeSessionFeedback,
} from '../src/message-feedback/api.js'
import { MessageFeedback } from '../src/message-feedback/form.js'
import { FeedbackProvenance } from '../src/message-feedback/provenance.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
afterEach(() => vi.unstubAllGlobals())
const empty: AdminFeedbackResult = {
  items: [],
  growth: [],
  counts: { up: 0, down: 0, withdrawn: 0, withCandidate: 0 },
  truncated: false,
}
const target = { messageSeq: 1, turn: 1 }
const saved: FeedbackItem = {
  id: 'feedback-1',
  sessionId: 'session',
  target,
  rating: 'up',
  category: '',
  note: '',
  actor: 'synthetic',
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z',
  revision: 1,
  withdrawn: false,
  candidateId: null,
  candidateHash: null,
}

it('shares one session load across mounted messages and provenance, then invalidates after submit', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const requests: { action: string; sessionId: string }[] = []
  let submitted = false
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const input = JSON.parse(String(init.body)) as { action: string; sessionId: string }
    requests.push(input)
    if (input.action === 'put') submitted = true
    return new Response(
      JSON.stringify({
        ...empty,
        items: submitted ? [saved] : [],
        counts: { ...empty.counts, up: submitted ? 1 : 0 },
      }),
    )
  })
  try {
    await act(async () =>
      root.render(
        <>
          <MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />
          <MessageFeedback sessionId="session" target={{ messageSeq: 2, turn: 1 }} openEvidence={() => {}} />
          <FeedbackProvenance sessionId="session" />
          <FeedbackProvenance sessionId="session" candidateId="candidate" />
        </>,
      ),
    )
    expect(requests.filter((input) => input.action === 'list')).toEqual([
      { action: 'list', sessionId: 'session' },
    ])
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="feedback-up"]')!.click())
    expect(requests.filter((input) => input.action === 'list')).toHaveLength(2)
    expect(requests.filter((input) => input.action === 'put')).toHaveLength(1)
    expect(host.querySelector('[data-testid="feedback-up"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.textContent).toContain('Feedback saved')
    await act(async () =>
      root.render(
        <>
          <MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />
          <MessageFeedback sessionId="session" target={{ messageSeq: 2, turn: 1 }} openEvidence={() => {}} />
          <FeedbackProvenance sessionId="session" />
          <FeedbackProvenance sessionId="other-session" />
        </>,
      ),
    )
    expect(requests.filter((input) => input.action === 'list' && input.sessionId === 'session')).toHaveLength(
      2,
    )
    expect(
      requests.filter((input) => input.action === 'list' && input.sessionId === 'other-session'),
    ).toHaveLength(1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it.each(['response', 'error'] as const)(
  'keeps shared loads alive for remaining subscribers and ignores a late %s after invalidation',
  async (late) => {
    const requests: { signal: AbortSignal; resolve(value: Response): void; reject(error: Error): void }[] = []
    vi.stubGlobal(
      'fetch',
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          requests.push({ signal: init.signal as AbortSignal, resolve, reject })
        }),
    )
    const offOne = subscribeSessionFeedback('pending-session', () => {})
    const offTwo = subscribeSessionFeedback('pending-session', () => {})
    try {
      const first = loadSessionFeedback('pending-session')
      const second = loadSessionFeedback('pending-session')
      expect(requests).toHaveLength(1)
      offOne()
      expect(requests[0]!.signal.aborted).toBe(false)
      invalidateSessionFeedback('pending-session')
      const fresh = loadSessionFeedback('pending-session')
      expect(requests).toHaveLength(2)
      const current = { ...empty, items: [{ ...saved, revision: 2 }], counts: { ...empty.counts, up: 1 } }
      requests[1]!.resolve(new Response(JSON.stringify(current)))
      await expect(fresh).resolves.toEqual(current)
      if (late === 'response')
        requests[0]!.resolve(
          new Response(JSON.stringify({ ...empty, items: [saved], counts: { ...empty.counts, up: 1 } })),
        )
      else requests[0]!.reject(new Error('old request failed'))
      await expect(Promise.all([first, second])).resolves.toEqual([current, current])
    } finally {
      offOne()
      offTwo()
    }
    expect(requests[1]!.signal.aborted).toBe(true)
  },
)

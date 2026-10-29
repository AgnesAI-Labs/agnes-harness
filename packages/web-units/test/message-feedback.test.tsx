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

type Sent = {
  action: string
  sessionId: string
  id?: string
  expectedRevision?: number | null
  rating?: 'up' | 'down'
  category?: FeedbackItem['category']
  note?: string
}

/** A local stand-in for the feedback RPC: one item per target, revisions advance on each write. */
function fakeServer(options: { failActions?: Set<string>; reason?: string } = {}) {
  const sent: Sent[] = []
  let current: FeedbackItem | undefined
  let hold: Promise<void> | undefined
  const server = {
    sent,
    hold(gate: Promise<void> | undefined) {
      hold = gate
    },
    get item() {
      return current
    },
    writes: () => sent.filter((input) => input.action !== 'list'),
  }
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const input = JSON.parse(String(init.body)) as Sent
    sent.push(input)
    if (input.action !== 'list') {
      if (hold) await hold
      if (options.failActions?.has(input.action))
        return new Response(
          JSON.stringify(options.reason ? { error: { code: -32011, data: { reason: options.reason } } } : {}),
          { status: options.reason ? 400 : 500 },
        )
      const revision = (current?.revision ?? 0) + 1
      if (input.action === 'put')
        current = {
          ...saved,
          ...current,
          rating: input.rating!,
          category: input.category ?? '',
          note: input.note ?? '',
          withdrawn: false,
          revision,
        }
      if (input.action === 'withdraw' && current) current = { ...current, withdrawn: true, revision }
      if (input.action === 'generate' && current)
        current = { ...current, candidateId: 'candidate-1', candidateHash: 'hash' }
    }
    return new Response(
      JSON.stringify({
        ...empty,
        items: current ? [current] : [],
        counts: { ...empty.counts, up: current?.rating === 'up' && !current.withdrawn ? 1 : 0 },
      }),
    )
  })
  return server
}

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  return {
    host,
    root,
    async dispose() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}
const button = (scope: ParentNode, id: string) =>
  scope.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
const popover = () => document.querySelector<HTMLElement>('[data-testid="feedback-popover"]')
const click = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const typeNote = async (value: string) => {
  const note = document.querySelector<HTMLTextAreaElement>('[data-testid="feedback-note"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(note, value)
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('shares one session load across mounted messages and provenance, then reloads after a rating', async () => {
  const server = fakeServer()
  const view = await mount(
    <>
      <MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />
      <MessageFeedback sessionId="session" target={{ messageSeq: 2, turn: 1 }} openEvidence={() => {}} />
      <FeedbackProvenance sessionId="session" />
      <FeedbackProvenance sessionId="session" candidateId="candidate" />
    </>,
  )
  try {
    expect(server.sent.filter((input) => input.action === 'list')).toEqual([
      { action: 'list', sessionId: 'session' },
    ])
    await click(button(view.host, 'feedback-up'))
    await settle()
    expect(server.sent.filter((input) => input.action === 'list')).toHaveLength(2)
    expect(server.writes()).toHaveLength(1)
  } finally {
    await view.dispose()
  }
})

it('saves the rating on one click, opens its reasons, and withdraws on a second click', async () => {
  const server = fakeServer()
  const view = await mount(<MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />)
  try {
    const up = button(view.host, 'feedback-up')!
    await click(up)
    await settle()
    expect(server.writes()).toEqual([
      expect.objectContaining({
        action: 'put',
        rating: 'up',
        category: '',
        note: '',
        expectedRevision: null,
      }),
    ])
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(up.getAttribute('aria-expanded')).toBe('true')
    expect(popover()?.dataset.rating).toBe('up')
    expect(
      [...popover()!.querySelectorAll('[data-testid^="feedback-reason-"]')].map((chip) => chip.textContent),
    ).toEqual(['Accurate', 'Did what I asked', 'Good style', 'Used tools well', 'Do this again'])
    // Thumbs up offers no draft until its reason is «do this again».
    expect(button(document, 'feedback-generate')).toBeNull()
    // Keyboard users start on the first reason.
    expect(document.activeElement).toBe(button(document, 'feedback-reason-accuracy'))
    // No saved banner: the pressed button is the confirmation.
    expect(view.host.textContent).not.toContain('Feedback saved')

    await click(up)
    await settle()
    expect(server.writes().at(-1)).toEqual(
      expect.objectContaining({ action: 'withdraw', id: 'feedback-1', expectedRevision: 1 }),
    )
    expect(up.getAttribute('aria-pressed')).toBe('false')
    expect(popover()).toBeNull()
  } finally {
    await view.dispose()
  }
})

it('maps each rating to its own reasons and saves the reason and note when the popover closes', async () => {
  const server = fakeServer()
  const view = await mount(<MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />)
  try {
    await click(button(view.host, 'feedback-down'))
    await settle()
    expect(
      [...popover()!.querySelectorAll<HTMLElement>('[data-testid^="feedback-reason-"]')].map(
        (chip) => chip.dataset.testid,
      ),
    ).toEqual([
      'feedback-reason-accuracy',
      'feedback-reason-instruction',
      'feedback-reason-style',
      'feedback-reason-tools',
      'feedback-reason-other',
    ])
    // Reasons are single-select.
    await click(button(document, 'feedback-reason-style'))
    await click(button(document, 'feedback-reason-tools'))
    expect(button(document, 'feedback-reason-style')?.getAttribute('aria-pressed')).toBe('false')
    expect(button(document, 'feedback-reason-tools')?.getAttribute('aria-pressed')).toBe('true')
    await typeNote('Use the project linter.')
    await click(button(document, 'feedback-done'))
    await settle()
    expect(popover()).toBeNull()
    expect(server.writes().at(-1)).toEqual(
      expect.objectContaining({
        action: 'put',
        rating: 'down',
        category: 'tools',
        note: 'Use the project linter.',
        expectedRevision: 1,
      }),
    )

    // Reopening via the other rating keeps the note but drops a reason that rating does not offer.
    await click(button(view.host, 'feedback-up'))
    await settle()
    expect(server.writes().at(-1)).toEqual(
      expect.objectContaining({ action: 'put', rating: 'up', category: 'tools', expectedRevision: 2 }),
    )
    await click(button(document, 'feedback-reason-do-again'))
    // Escape closes and saves.
    await act(async () =>
      popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    await settle()
    expect(popover()).toBeNull()
    expect(server.item).toEqual(expect.objectContaining({ rating: 'up', category: 'do-again', revision: 4 }))
    expect(document.activeElement).toBe(button(view.host, 'feedback-up'))

    // A click outside closes and saves too; closing unchanged writes nothing.
    await click(button(view.host, 'feedback-up'))
    await settle()
    const writes = server.writes().length
    expect(server.writes().at(-1)?.action).toBe('withdraw')
    await click(button(view.host, 'feedback-down'))
    await settle()
    await typeNote('Too long.')
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    await settle()
    expect(popover()).toBeNull()
    expect(server.writes()).toHaveLength(writes + 2)
    expect(server.item).toEqual(expect.objectContaining({ rating: 'down', note: 'Too long.' }))
    await click(button(view.host, 'feedback-down'))
    await settle()
    expect(server.item?.withdrawn).toBe(true)
  } finally {
    await view.dispose()
  }
})

it('drafts a suggestion through the existing generate path and links to review', async () => {
  const server = fakeServer()
  let release: (() => void) | undefined
  const openReview = vi.fn()
  const view = await mount(
    <MessageFeedback sessionId="session" target={target} openEvidence={() => {}} openReview={openReview} />,
  )
  try {
    await click(button(view.host, 'feedback-down'))
    await settle()
    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="feedback-generate"]')!
    expect(checkbox.closest('label')?.textContent).toContain('Draft an improvement suggestion')
    await click(button(document, 'feedback-reason-accuracy'))
    await act(async () => checkbox.click())
    server.hold(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    await click(button(document, 'feedback-done'))
    await settle()
    const status = view.host.querySelector('[data-testid="feedback-status"]')!
    expect(status.textContent).toBe('Drafting suggestion…')
    await act(async () => release?.())
    await settle()
    expect(server.writes().map((input) => input.action)).toEqual(['put', 'put', 'generate'])
    expect(server.writes().at(-1)).toEqual(
      expect.objectContaining({ action: 'generate', id: 'feedback-1', expectedRevision: 2 }),
    )
    expect(status.textContent).toBe('✓ Suggestion draft ready · Open Review')
    await click(button(view.host, 'feedback-open-review'))
    expect(openReview).toHaveBeenCalledOnce()
  } finally {
    server.hold(undefined)
    release?.()
    await view.dispose()
  }
})

it('shows a retry at the right of the row when a save or a draft fails', async () => {
  const failActions = new Set(['put'])
  const server = fakeServer({ failActions })
  const view = await mount(<MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />)
  try {
    await click(button(view.host, 'feedback-down'))
    await settle()
    const status = view.host.querySelector('[data-testid="feedback-status"]')!
    expect(status.textContent).toBe('Feedback not saved · Retry')
    expect(status.getAttribute('data-tone')).toBe('error')
    expect(button(view.host, 'feedback-down')?.getAttribute('aria-pressed')).toBe('false')
    failActions.clear()
    await click(button(view.host, 'feedback-retry'))
    await settle()
    expect(status.textContent).toBe('')
    expect(button(view.host, 'feedback-down')?.getAttribute('aria-pressed')).toBe('true')

    // Withdraw and rate again to reach the popover's draft request.
    await click(button(view.host, 'feedback-down'))
    await settle()
    await click(button(view.host, 'feedback-down'))
    await settle()
    failActions.add('generate')
    await act(async () =>
      document.querySelector<HTMLInputElement>('[data-testid="feedback-generate"]')!.click(),
    )
    await click(button(document, 'feedback-done'))
    await settle()
    expect(status.textContent).toBe('Suggestion not drafted · Retry')
    failActions.clear()
    await click(button(view.host, 'feedback-retry'))
    await settle()
    expect(status.textContent).toBe('✓ Suggestion draft ready')
    expect(server.writes().filter((input) => input.action === 'generate')).toHaveLength(2)
  } finally {
    await view.dispose()
  }
})

it('says a local model is needed instead of offering a retry the server will refuse', async () => {
  fakeServer({ failActions: new Set(['generate']), reason: 'FEEDBACK_LOCAL_MODEL_REQUIRED' })
  const view = await mount(<MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />)
  try {
    await click(button(view.host, 'feedback-down'))
    await settle()
    await act(async () =>
      document.querySelector<HTMLInputElement>('[data-testid="feedback-generate"]')!.click(),
    )
    await click(button(document, 'feedback-done'))
    await settle()
    expect(view.host.querySelector('[data-testid="feedback-status"]')?.textContent).toBe(
      'Drafting a suggestion needs a local model',
    )
    expect(button(view.host, 'feedback-retry')).toBeNull()
  } finally {
    await view.dispose()
  }
})

it('has no old form: no category select, save, withdraw or note buttons, and no comment icon', async () => {
  fakeServer()
  const view = await mount(<MessageFeedback sessionId="session" target={target} openEvidence={() => {}} />)
  try {
    for (const id of ['feedback-details', 'feedback-category', 'feedback-save', 'feedback-withdraw'])
      expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull()
    expect(view.host.querySelectorAll('fieldset button')).toHaveLength(2)
    await click(button(view.host, 'feedback-up'))
    await settle()
    expect(document.querySelector('select')).toBeNull()
    expect(popover()?.textContent).toContain('Saved on this device only')
    for (const id of ['feedback-details', 'feedback-category', 'feedback-save', 'feedback-withdraw'])
      expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull()
  } finally {
    await view.dispose()
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

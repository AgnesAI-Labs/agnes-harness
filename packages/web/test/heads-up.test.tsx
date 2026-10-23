/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanNote, headsUpNote, loadHeadsUp } from '../src/heads-up.js'
import { HeadsUpNote, SessionHeadsUp } from '../src/heads-up-view.js'

afterEach(() => {
  vi.unstubAllGlobals()
  headsUpNote.set(undefined)
})

const t = (key: string) => key

function stubService(outputs: Array<Record<string, unknown> | 'fail'>) {
  const bodies: Array<Record<string, unknown>> = []
  const queue = [...outputs]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      const next = queue.length > 1 ? queue.shift() : queue[0]
      return next === 'fail'
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ output: next }) }
    }),
  )
  return bodies
}

it('reads the note after a finished turn until the review settles, cleaning what it shows', async () => {
  const bodies = stubService([
    { enabled: true, busy: true },
    { enabled: true, busy: false, turn: 2, text: 'Removed build/\u0007 dir' },
  ])
  await loadHeadsUp({ sessionId: 's1', turn: 2 }, new AbortController().signal, async () => undefined)
  expect(bodies[0]).toEqual({
    rowId: 'web:builtin:agnes/heads-up',
    sessionId: 's1',
    service: 'headsup.read',
    input: { turn: 2 },
  })
  expect(headsUpNote.getSnapshot()).toEqual({ sessionId: 's1', turn: 2, text: 'Removed build/ dir' })
  expect(cleanNote('a‮b\n c')).toBe('a b c')
})

it('shows nothing when heads-up is off, the call fails or the turn is superseded', async () => {
  stubService([{ enabled: false }])
  await loadHeadsUp({ sessionId: 's1', turn: 1 }, new AbortController().signal)
  expect(headsUpNote.getSnapshot()).toBeUndefined()
  stubService(['fail'])
  await loadHeadsUp({ sessionId: 's1', turn: 1 }, new AbortController().signal)
  expect(headsUpNote.getSnapshot()).toBeUndefined()
  stubService([{ enabled: true, text: 'late' }])
  const abort = new AbortController()
  abort.abort()
  await loadHeadsUp({ sessionId: 's1', turn: 1 }, abort.signal)
  expect(headsUpNote.getSnapshot()).toBeUndefined()
})

it('renders the note for its own session only and the setting starts from what the extension says', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(createElement(HeadsUpNote, { sessionId: 's1', t }))
      headsUpNote.set({ sessionId: 's1', turn: 1, text: 'Check the path' })
    })
    expect(host.querySelector('[data-testid="heads-up-note"]')?.textContent).toContain('Check the path')
    await act(async () => root.render(createElement(HeadsUpNote, { sessionId: 's2', t })))
    expect(host.textContent).toBe('')
    const bodies = stubService([{ enabled: false }, { enabled: true }])
    await act(async () => root.render(createElement(SessionHeadsUp, { sessionId: 's1', t })))
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('headsUp.sends')
    await act(async () => toggle?.click())
    expect(bodies.at(-1)).toMatchObject({ service: 'headsup.set', input: { enabled: true } })
    expect(host.querySelector('button[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

// @vitest-environment happy-dom

import type { UINode, UITurn } from '@agnes/protocol'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { createTraceViewMemory, TRACE_VIEWS_STORAGE_KEY } from '../../web-units/src/trace-view-memory.js'
import { TRACE_PANEL_STORAGE_KEY, Trace, type TraceHandle } from '../src/trace-panel.js'

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  while (roots.length) roots.pop()?.unmount()
  document.body.replaceChildren()
  document.body.className = ''
  sessionStorage.clear()
})

const at = '2026-10-15T00:00:00.000Z'
const recorded: UINode[] = [
  { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '帮我安装 mcp' }] },
]
const turns: UITurn[] = [
  {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: at,
    status: 'completed',
    nodeIds: ['u1'],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
  },
]

function mount() {
  const root = document.createElement('aside')
  const toggle = document.createElement('button')
  const chat = document.createElement('button')
  const conversation = document.createElement('div')
  toggle.setAttribute('role', 'tab')
  chat.setAttribute('role', 'tab')
  document.body.append(root, toggle, chat, conversation)
  const handle = { current: null as TraceHandle | null }
  const reactRoot = createRoot(root)
  flushSync(() =>
    reactRoot.render(
      createElement(Trace, {
        ref: handle,
        root,
        options: { toggle, chatToggle: chat, conversation, store: sessionStorage },
      }),
    ),
  )
  roots.push(reactRoot)
  const panel = handle.current as TraceHandle
  /** What the person sees: the trace (true) or the conversation with its composer (false). */
  const showingTrace = () => {
    const trace = !root.hidden
    expect(conversation.hidden).toBe(trace)
    expect(toggle.getAttribute('aria-selected')).toBe(String(trace))
    expect(chat.getAttribute('aria-selected')).toBe(String(!trace))
    expect(document.body.classList.contains('trace-open')).toBe(trace)
    return trace
  }
  return { panel, toggle, chat, showingTrace }
}

it('starts a new session on the conversation even when the trace was showing', () => {
  const { panel, toggle, showingTrace } = mount()
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'mcp' })
  flushSync(() => toggle.click())
  expect(showingTrace()).toBe(true)
  // A new draft: the app renders the trace with nothing in it and no session.
  panel.render([], [])
  expect(showingTrace()).toBe(false)
  // Its first records arrive under its new id: still the conversation, which the person is using.
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'fresh' })
  expect(showingTrace()).toBe(false)
})

it('opens an older session with nothing recorded on the conversation', () => {
  const { panel, toggle, showingTrace } = mount()
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'mcp' })
  flushSync(() => toggle.click())
  panel.render([], [], { hasEarlier: false, sessionId: 'empty' })
  expect(showingTrace()).toBe(false)
})

it('returns each session with records to the view it was left in', () => {
  const { panel, toggle, chat, showingTrace } = mount()
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'traced' })
  flushSync(() => toggle.click())
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'chatted' })
  expect(showingTrace()).toBe(false)
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'traced' })
  expect(showingTrace()).toBe(true)
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'chatted' })
  flushSync(() => chat.click())
  expect(showingTrace()).toBe(false)
  // While a session is still loading (no records yet), the conversation shows; its view returns
  // as soon as its records arrive.
  panel.render([], [], { hasEarlier: false, sessionId: 'traced' })
  expect(showingTrace()).toBe(false)
  panel.render(recorded, turns, { hasEarlier: false, sessionId: 'traced' })
  expect(showingTrace()).toBe(true)
})

it('remembers views per session in this tab and survives a reload', () => {
  const memory = createTraceViewMemory(sessionStorage, undefined)
  memory.remember('a', true)
  memory.remember('b', false)
  expect(JSON.parse(sessionStorage.getItem(TRACE_VIEWS_STORAGE_KEY) ?? '[]')).toEqual([
    ['a', true],
    ['b', false],
  ])
  const reloaded = createTraceViewMemory(sessionStorage, undefined)
  expect(reloaded.viewFor('a', true)).toBe(true)
  expect(reloaded.viewFor('b', true)).toBe(false)
  expect(reloaded.viewFor('a', false)).toBe(false)
  expect(reloaded.viewFor('unknown', true)).toBe(false)
  // Broken storage is ignored rather than trusted.
  sessionStorage.setItem(TRACE_VIEWS_STORAGE_KEY, '{oops')
  expect(createTraceViewMemory(sessionStorage, undefined).viewFor('a', true)).toBe(false)
  // The single choice from before a reload only answers the first decision.
  sessionStorage.setItem(TRACE_PANEL_STORAGE_KEY, 'open')
  const legacy = createTraceViewMemory(sessionStorage, true)
  expect(legacy.viewFor(undefined, true)).toBe(true)
  expect(legacy.viewFor('other', true)).toBe(false)
})

/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import {
  type ConversationProjectionStore,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessage,
  useExternalStoreRuntime,
  useThread,
} from '@assistant-ui/react'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  observed = undefined
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function BoundaryProbe() {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messageRepository: ExportedMessageRepository.fromArray([
      { id: 'boundary', role: 'user', content: 'ready' },
    ]),
    onNew: async () => {
      throw new Error('read-only boundary')
    },
  })
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(BoundaryMessages))
}

function BoundaryMessages() {
  const messages = useThread((state) => state.messages)
  return createElement('output', null, messages.map((message) => message.id).join(','))
}

function AdapterProbe({
  store,
  onRuntime,
}: {
  store: ConversationProjectionStore
  onRuntime: (runtime: AssistantRuntime) => void
}) {
  const runtime = useConversationRuntime(store)
  useEffect(() => onRuntime(runtime), [onRuntime, runtime])
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(AdapterMessages))
}

function AdapterMessages() {
  const messages = useThread((state) => state.messages)
  return createElement(
    'section',
    null,
    messages.map((message) => {
      const custom = message.metadata.custom as {
        kind: string
        turnId?: string
        turnStatus?: string
        isFinal: boolean
      }
      const text = message.content
        .filter((part) => part.type === 'text' || part.type === 'reasoning')
        .map((part) => ('text' in part ? part.text : ''))
        .join(' | ')
      return createElement(
        'article',
        {
          key: message.id,
          'data-id': message.id,
          'data-kind': custom.kind,
          'data-status': message.status?.type,
          'data-reason': message.status && 'reason' in message.status ? message.status.reason : '',
          'data-turn-id': custom.turnId,
          'data-turn-status': custom.turnStatus,
          'data-final': String(custom.isFinal),
        },
        text,
      )
    }),
  )
}

const usage: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}

function turn(
  nodeIds: string[],
  status: UITurn['status'] = 'running',
  reason?: UITurn['reason'],
  finalAssistantId?: string,
): UITurn {
  return {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-09-25T00:00:00.000Z',
    status,
    nodeIds,
    ...(reason ? { reason } : {}),
    ...(finalAssistantId ? { finalAssistantId } : {}),
    usage,
    inherited: false,
    forkable: true,
  }
}

let observed: AssistantRuntime | undefined
const observe = (runtime: AssistantRuntime) => {
  observed = runtime
}

async function mount(store: ConversationProjectionStore) {
  await act(async () => root.render(createElement(AdapterProbe, { store, onRuntime: observe })))
}

async function update(store: ConversationProjectionStore, projection: Parameters<typeof store.update>[0]) {
  await act(async () => store.update(projection))
}

const rendered = () => Array.from(host.querySelectorAll<HTMLElement>('article'))
const ids = () => rendered().map((item) => item.dataset.id)
const byId = (id: string) => host.querySelector<HTMLElement>(`article[data-id="${id}"]`)

describe('W3a runtime boundary', () => {
  it('reads a full repository through the installed runtime subscription', async () => {
    await act(async () => root.render(createElement(BoundaryProbe)))
    expect(host.querySelector('output')?.textContent).toBe('boundary')
  })
})

describe('W3a projected conversation adapter', () => {
  it('replaces same-ID stream and business states without duplicate runtime messages', async () => {
    const user: UINode = {
      kind: 'user',
      id: 'u1',
      seq: 1,
      content: [
        { type: 'text', text: 'ask' },
        { type: 'text', text: 'again' },
      ],
    }
    const assistant: UINode = {
      kind: 'assistant',
      id: 'a1',
      seq: 2,
      thinking: 'checking',
      text: 'first',
      streaming: true,
    }
    const tool: UINode = {
      kind: 'tool',
      id: 't1',
      seq: 3,
      toolUseId: 'call-1',
      name: 'read_file',
      status: 'running',
      summary: 'reading',
    }
    const approval: UINode = {
      kind: 'approval',
      id: 'p1',
      seq: 4,
      state: 'pending',
      summary: 'allow?',
      risk: 'unknown',
      options: ['allow_once'],
    }
    const cost: UINode = { kind: 'cost', id: 'c1', seq: 5, source: 'estimated' }
    const store = createConversationProjectionStore({
      sessionId: 'one',
      nodes: [user, assistant, tool, approval, cost],
      turns: [turn(['u1', 'a1', 't1', 'p1', 'c1'])],
    })
    await mount(store)
    expect(ids()).toEqual(['u1', 'a1', 't1', 'p1', 'c1'])
    expect(byId('u1')?.textContent).toBe('ask\nagain')
    expect(byId('a1')?.textContent).toBe('checking | first')
    expect(byId('a1')?.dataset.status).toBe('running')
    expect(byId('a1')?.dataset.turnId).toBe('turn:1')

    const settled = {
      sessionId: 'one',
      nodes: [
        user,
        { ...assistant, text: 'first second', streaming: false },
        { ...tool, status: 'completed' as const, summary: 'read' },
        { ...approval, state: 'decided' as const, decision: { verdict: 'allowed-once', via: 'user' } },
        { ...cost, source: 'gateway' as const, credits: 1.25 },
      ],
      turns: [turn(['u1', 'a1', 't1', 'p1', 'c1'], 'completed', 'completed', 'a1')],
    }
    await update(store, settled)
    await update(store, settled)
    expect(ids()).toEqual(['u1', 'a1', 't1', 'p1', 'c1'])
    expect(byId('a1')?.textContent).toBe('checking | first second')
    expect(byId('a1')?.dataset.status).toBe('complete')
    expect(byId('a1')?.dataset.final).toBe('true')
    expect(byId('t1')?.textContent).toContain('read')
    expect(byId('p1')?.textContent).toContain('allow?')
    expect(byId('c1')?.textContent).toContain('1.25')
    expect(observed?.thread.getState().messages.map((message) => message.id)).toEqual(ids())
    const current = observed?.thread.getState().messages
    expect(current?.find((message) => message.id === 't1')?.metadata.custom.node).toEqual(settled.nodes[2])
    expect(current?.find((message) => message.id === 'p1')?.metadata.custom.node).toEqual(settled.nodes[3])
    expect(current?.find((message) => message.id === 'c1')?.metadata.custom.node).toEqual(settled.nodes[4])
  })

  it('imports the complete repository for out-of-order projections and history prepends', async () => {
    const latest: UINode = { kind: 'assistant', id: 'a2', seq: 4, text: 'latest' }
    const user: UINode = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'earlier' }] }
    const lost: UINode = { kind: 'assistant', id: 'a1', seq: 2, text: '', lostChars: 7 }
    const store = createConversationProjectionStore({ sessionId: 'one', nodes: [latest] })
    await mount(store)
    expect(ids()).toEqual(['a2'])
    await update(store, { sessionId: 'one', nodes: [user, lost, latest] })
    expect(ids()).toEqual(['u1', 'a1', 'a2'])
    expect(byId('a1')?.textContent).toContain('7')
    expect(byId('a2')?.textContent).toBe('latest')
    await update(store, { sessionId: 'one', nodes: [latest, user, lost] })
    expect(ids()).toEqual(['a2', 'u1', 'a1'])
    const oldest: UINode = { kind: 'user', id: 'u0', seq: 0, content: [{ type: 'text', text: 'oldest' }] }
    await update(store, { sessionId: 'one', nodes: [oldest, latest, user, lost] })
    expect(ids()).toEqual(['u0', 'a2', 'u1', 'a1'])
    expect(new Set(ids()).size).toBe(4)
  })

  it('replaces all message and turn state when the session changes', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'one',
      nodes: [{ kind: 'assistant', id: 'a1', seq: 1, text: 'old' }],
      turns: [turn(['a1'], 'completed', 'completed', 'a1')],
    })
    await mount(store)
    await update(store, {
      sessionId: 'two',
      nodes: [{ kind: 'assistant', id: 'a1', seq: 1, text: 'new' }],
    })
    expect(ids()).toEqual(['a1'])
    expect(byId('a1')?.textContent).toBe('new')
    expect(byId('a1')?.dataset.turnId).toBeUndefined()
    expect(byId('a1')?.dataset.final).toBe('false')
    await update(store, { sessionId: 'two', nodes: [] })
    expect(ids()).toEqual([])
  })

  it.each([
    ['cancelled', 'aborted', 'incomplete', 'cancelled'],
    ['failed', 'error', 'incomplete', 'error'],
    ['completed', 'completed', 'complete', 'stop'],
  ] as const)(
    'keeps the %s terminal content and status stable',
    async (turnStatus, reason, status, runtimeReason) => {
      const running: UINode = { kind: 'assistant', id: 'a1', seq: 1, text: 'partial', streaming: true }
      const store = createConversationProjectionStore({
        sessionId: 'one',
        nodes: [running],
        turns: [turn(['a1'])],
      })
      await mount(store)
      expect(byId('a1')?.dataset.status).toBe('running')
      const terminal = {
        sessionId: 'one',
        nodes: [{ ...running, streaming: false }],
        turns: [turn(['a1'], turnStatus, reason, 'a1')],
      }
      await update(store, terminal)
      await update(store, terminal)
      expect(ids()).toEqual(['a1'])
      expect(byId('a1')?.textContent).toBe('partial')
      expect(byId('a1')?.dataset.status).toBe(status)
      expect(byId('a1')?.dataset.reason).toBe(runtimeReason)
      expect(byId('a1')?.dataset.turnStatus).toBe(turnStatus)
    },
  )

  it('keeps context-only nodes out of chat while retaining the source projection', async () => {
    const nodes: UINode[] = [
      { kind: 'context', id: 'ctx', seq: 1, text: 'private context' },
      { kind: 'context-sections', id: 'sections', seq: 2, sections: [] },
      { kind: 'slot', id: 'slot', fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: {} } },
      { kind: 'contribute-conflict', id: 'conflict', seq: 3, key: 'memory', ops: ['replace'] },
      {
        kind: 'artifact',
        id: 'artifact',
        seq: 4,
        name: 'report.md',
        ref: { sha256: 'a'.repeat(64), size: 3, mime: 'text/markdown' },
      },
      { kind: 'compaction', id: 'compaction', seq: 5, range: [1, 4] },
    ]
    const store = createConversationProjectionStore({ sessionId: 'one', nodes, meta: { hasEarlier: true } })
    await mount(store)
    expect(ids()).toEqual(['slot', 'conflict', 'artifact', 'compaction'])
    expect(rendered().map((item) => item.dataset.kind)).toEqual([
      'slot',
      'contribute-conflict',
      'artifact',
      'compaction',
    ])
    expect(store.getSnapshot().nodes).toBe(nodes)
    expect(store.getSnapshot().meta?.hasEarlier).toBe(true)
  })

  it('unsubscribes from the projection store when the runtime harness unmounts', async () => {
    const store = createConversationProjectionStore({ sessionId: 'one', nodes: [] })
    const subscribe = store.subscribe
    let active = 0
    const tracked: ConversationProjectionStore = {
      ...store,
      subscribe: (listener) => {
        active++
        const dispose = subscribe(listener)
        return () => {
          active--
          dispose()
        }
      },
    }
    await mount(tracked)
    expect(active).toBe(1)
    await act(async () => root.render(createElement('output', null, 'unmounted')))
    expect(active).toBe(0)
    await update(store, { sessionId: 'two', nodes: [{ kind: 'assistant', id: 'a2', seq: 1, text: 'late' }] })
    expect(host.querySelector('output')?.textContent).toBe('unmounted')
  })
})

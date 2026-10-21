/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import {
  ConversationMessages,
  type ConversationProjectionStore,
  conversationNodes,
  createConversationProjectionStore,
  useConversationProjection,
} from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zhT } from './locale.js'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function Probe({ store }: { store: ConversationProjectionStore }) {
  const projection = useConversationProjection(store)
  return createElement(ConversationMessages, {
    t: zhT,
    nodes: projection.nodes,
    ...(projection.turns ? { turns: projection.turns } : {}),
  })
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

async function mount(store: ConversationProjectionStore) {
  await act(async () => root.render(createElement(Probe, { store })))
}

async function update(store: ConversationProjectionStore, projection: Parameters<typeof store.update>[0]) {
  await act(async () => store.update(projection))
}

const rendered = () => Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]'))
const ids = () => rendered().map((item) => item.dataset.nodeId)
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
const turnElement = () => host.querySelector<HTMLElement>('[data-testid="conversation-turn"]')

describe('conversation projection store', () => {
  it('renders persisted delegation attribution after rebuilding the projection store', async () => {
    document.documentElement.lang = 'zh-CN'
    const node: UINode = {
      kind: 'tool',
      id: 'role',
      seq: 2,
      toolUseId: 'spawn',
      name: 'subagent_spawn',
      status: 'completed',
      summary: 'Delegated investigation',
      delegatedRole: { ref: '@fixture/roles#reader', title: { en: 'Reader', 'zh-CN': '读者' } },
    }
    const projection = {
      sessionId: 'roles',
      upto: 3,
      opState: null,
      pendingInputs: [],
      nodes: [node],
      turns: [turn(['role'], 'completed', 'completed')],
    }
    await mount(createConversationProjectionStore(projection))
    expect(host.textContent).toContain('由 读者 处理')
    await act(async () => root.unmount())
    root = createRoot(host)
    sessionStorage.clear()
    await mount(createConversationProjectionStore(JSON.parse(JSON.stringify(projection))))
    expect(host.textContent).toContain('由 读者 处理')
  })

  it('replaces same-ID stream and business states in place, one article per source ID', async () => {
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
    const store = createConversationProjectionStore({
      sessionId: 'one',
      nodes: [user, assistant, tool, approval],
      turns: [turn(['u1', 'a1', 't1', 'p1'])],
    })
    await mount(store)
    expect([...ids()].sort()).toEqual(['a1', 'p1', 't1', 'u1'])
    expect(byId('u1')?.querySelector('.node-body')?.textContent).toBe('ask\nagain')
    expect(byId('a1')?.dataset.streaming).toBe('true')
    expect(turnElement()?.dataset.status).toBe('running')
    const articles = new Map(ids().map((id) => [id, byId(id as string)]))

    const settled = {
      sessionId: 'one',
      nodes: [
        user,
        { ...assistant, text: 'first second', streaming: false },
        { ...tool, status: 'completed' as const, summary: 'read' },
        { ...approval, state: 'decided' as const, decision: { verdict: 'allowed-once', via: 'user' } },
      ] satisfies UINode[],
      turns: [turn(['u1', 'a1', 't1', 'p1'], 'completed', 'completed', 'a1')],
    }
    await update(store, settled)
    await update(store, settled)
    expect(new Set(ids()).size).toBe(4)
    expect(rendered()).toHaveLength(4)
    for (const [id, article] of articles) expect(byId(id as string)).toBe(article)
    expect(byId('a1')?.querySelector('.node-body')?.textContent).toBe('first second')
    expect(byId('a1')?.dataset.streaming).toBe('false')
    expect(byId('a1')?.closest('.turn-final')).not.toBeNull()
    expect(byId('t1')?.dataset.status).toBe('completed')
    expect(byId('p1')?.dataset.state).toBe('decided')
    expect(turnElement()?.dataset.status).toBe('completed')
  })

  it('follows out-of-order projections and history prepends without duplicates', async () => {
    const latest: UINode = { kind: 'assistant', id: 'a2', seq: 4, text: 'latest' }
    const user: UINode = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'earlier' }] }
    const lost: UINode = { kind: 'assistant', id: 'a1', seq: 2, text: '', lostChars: 7 }
    const store = createConversationProjectionStore({ sessionId: 'one', nodes: [latest] })
    await mount(store)
    expect(ids()).toEqual(['a2'])
    await update(store, { sessionId: 'one', nodes: [user, lost, latest] })
    expect(ids()).toEqual(['u1', 'a1', 'a2'])
    expect(byId('a1')?.textContent).toContain('输出中断，至少 7 字未保存')
    expect(byId('a2')?.querySelector('.node-body')?.textContent).toBe('latest')
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
    expect(turnElement()).not.toBeNull()
    await update(store, {
      sessionId: 'two',
      nodes: [{ kind: 'assistant', id: 'a1', seq: 1, text: 'new' }],
    })
    expect(ids()).toEqual(['a1'])
    expect(byId('a1')?.querySelector('.node-body')?.textContent).toBe('new')
    expect(turnElement()).toBeNull()
    await update(store, { sessionId: 'two', nodes: [] })
    expect(ids()).toEqual([])
  })

  it.each([
    ['cancelled', 'aborted'],
    ['failed', 'error'],
    ['completed', 'completed'],
  ] as const)('keeps the %s terminal content and status stable', async (turnStatus, reason) => {
    const running: UINode = { kind: 'assistant', id: 'a1', seq: 1, text: 'partial', streaming: true }
    const store = createConversationProjectionStore({
      sessionId: 'one',
      nodes: [running],
      turns: [turn(['a1'])],
    })
    await mount(store)
    expect(byId('a1')?.dataset.streaming).toBe('true')
    // A terminal turn ends streaming even when the last delta never cleared the node flag.
    const terminal = { sessionId: 'one', nodes: [running], turns: [turn(['a1'], turnStatus, reason, 'a1')] }
    await update(store, terminal)
    await update(store, terminal)
    expect(ids()).toEqual(['a1'])
    expect(byId('a1')?.querySelector('.node-body')?.textContent).toBe('partial')
    expect(byId('a1')?.dataset.streaming).toBe('false')
    expect(turnElement()?.dataset.status).toBe(turnStatus)
  })

  it('keeps context-only and empty settled assistant nodes out of chat while retaining the source projection', async () => {
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
      { kind: 'assistant', id: 'blank', seq: 6, text: '  ' },
    ]
    const store = createConversationProjectionStore({ sessionId: 'one', nodes, meta: { hasEarlier: true } })
    await mount(store)
    expect(ids()).toEqual(['slot', 'conflict', 'artifact', 'compaction'])
    expect(rendered().map((item) => item.dataset.nodeKind)).toEqual([
      'slot',
      'contribute-conflict',
      'artifact',
      'compaction',
    ])
    expect([...conversationNodes(nodes).keys()]).toEqual(ids())
    expect(store.getSnapshot().nodes).toBe(nodes)
    expect(store.getSnapshot().meta?.hasEarlier).toBe(true)
  })

  it('unsubscribes from the projection store when the reader unmounts', async () => {
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

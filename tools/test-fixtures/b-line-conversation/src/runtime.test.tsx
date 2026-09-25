import type { AssistantRuntime } from '@assistant-ui/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UINode, UITurn } from '../../../../packages/protocol/src/index.js'
import { projectVisible, type SpikeProjection } from './projection.js'
import { RuntimeFixture } from './runtime-fixture.js'

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
  document.body.replaceChildren()
})

const usage: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}

function turn(nodeIds: string[], finalAssistantId?: string): UITurn {
  return {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-09-25T00:00:00.000Z',
    status: 'running',
    nodeIds,
    ...(finalAssistantId ? { finalAssistantId } : {}),
    usage,
    inherited: false,
    forkable: true,
  }
}

function allKinds(): UINode[] {
  return [
    { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'hello' }] },
    { kind: 'assistant', id: 'a1', seq: 2, thinking: 'thinking', text: 'answer' },
    {
      kind: 'tool',
      id: 't1',
      seq: 3,
      toolUseId: 'call-1',
      name: 'read_file',
      status: 'completed',
      summary: 'done',
    },
    {
      kind: 'approval',
      id: 'p1',
      seq: 4,
      state: 'pending',
      summary: 'grant access',
      risk: 'unknown',
      options: ['allow_once'],
    },
    { kind: 'cost', id: 'c1', seq: 5, source: 'estimated' },
    {
      kind: 'artifact',
      id: 'r1',
      seq: 6,
      name: 'report.md',
      ref: { sha256: 'a'.repeat(64), size: 3, mime: 'text/markdown' },
    },
    { kind: 'compaction', id: 'h1', seq: 7, range: [1, 6] },
    {
      kind: 'slot',
      id: 's1',
      seq: 8,
      fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: { n: 1 } },
    },
    {
      kind: 'context-sections',
      id: 'cs1',
      seq: 9,
      sections: [{ id: 'memory', order: 1, source: 'test', tokens: 2 }],
    },
    { kind: 'contribute-conflict', id: 'x1', seq: 10, key: 'memory', ops: ['replace'] },
    { kind: 'context', id: 'ctx1', seq: 11, text: 'hidden context' },
  ]
}

async function paint(
  projection: SpikeProjection,
  onRuntime?: (runtime: AssistantRuntime) => void,
  onUnexpectedNew?: () => void,
  mode: 'messages' | 'repository' = 'messages',
) {
  await act(async () =>
    root.render(
      <RuntimeFixture
        projection={projection}
        {...(onRuntime ? { onRuntime } : {})}
        {...(onUnexpectedNew ? { onUnexpectedNew } : {})}
        mode={mode}
      />,
    ),
  )
}

describe('B-0 / S1 ExternalStoreRuntime projection', () => {
  it('carries every visible UINode kind through the real runtime and keeps context-only nodes out of chat', async () => {
    const nodes = allKinds()
    let runtime: AssistantRuntime | undefined
    await paint({ sessionId: 'session-a', nodes }, (value) => {
      runtime = value
    })

    const rendered = Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]'))
    expect(rendered.map((item) => item.dataset.nodeId)).toEqual([
      'u1',
      'a1',
      't1',
      'p1',
      'c1',
      'r1',
      'h1',
      's1',
      'x1',
    ])
    expect(rendered.map((item) => item.dataset.nodeKind)).toEqual([
      'user',
      'assistant',
      'tool',
      'approval',
      'cost',
      'artifact',
      'compaction',
      'slot',
      'contribute-conflict',
    ])
    expect(rendered.find((item) => item.dataset.nodeId === 'a1')?.textContent).toBe('thinking | answer')
    expect(runtime?.thread.getState().messages.map((message) => message.id)).toEqual(
      rendered.map((item) => item.dataset.nodeId),
    )
    expect(projectVisible({ sessionId: 'session-a', nodes }).map((message) => message.id)).not.toContain(
      'ctx1',
    )
    expect(nodes.map((node) => node.kind)).toContain('context')
    expect(nodes.map((node) => node.kind)).toContain('context-sections')
  })

  it('updates the same IDs, turn ownership and final marker without duplicate messages or outbound requests', async () => {
    const outbound = vi.fn()
    const user: UINode = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'ask' }] }
    const assistant: UINode = {
      kind: 'assistant',
      id: 'a1',
      seq: 2,
      thinking: 'reasoning',
      text: '',
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
    const first = {
      sessionId: 'session-a',
      nodes: [user, assistant, tool, approval, cost],
      turns: [turn(['u1', 'a1', 't1', 'p1', 'c1'])],
    }
    await paint(first, undefined, outbound)
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toBe('reasoning')
    expect(host.querySelector('[data-node-id="a1"]')?.getAttribute('data-status')).toBe('running')

    const settled: UINode[] = [
      user,
      { ...assistant, text: 'final answer', streaming: false },
      { ...tool, status: 'completed', summary: 'read' },
      { ...approval, state: 'decided', decision: { verdict: 'allowed-once', via: 'user' } },
      { ...cost, source: 'gateway', credits: 1.25 },
    ]
    const second = {
      sessionId: 'session-a',
      nodes: settled,
      turns: [turn(['u1', 'a1', 't1', 'p1', 'c1'], 'a1')],
    }
    await paint(second, undefined, outbound)
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toBe('reasoning | final answer')
    expect(host.querySelector('[data-node-id="a1"]')?.getAttribute('data-final')).toBe('true')
    expect(host.querySelector('[data-node-id="t1"]')?.textContent).toBe('read_file: read')
    expect(host.querySelector('[data-node-id="p1"]')?.textContent).toBe('decided: allow?')
    expect(host.querySelector('[data-node-id="c1"]')?.textContent).toBe('gateway: 1.25')
    await paint(second, undefined, outbound)
    expect(host.querySelectorAll('[data-node-id]')).toHaveLength(5)
    expect(outbound).not.toHaveBeenCalled()
  })

  it.fails('messages-array adapter loses the old tail when history is prepended', async () => {
    const live: UINode = { kind: 'assistant', id: 'a2', seq: 4, text: 'latest' }
    await paint({ sessionId: 'session-a', nodes: [live] })
    const earlier: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'earlier' }] },
      { kind: 'assistant', id: 'a1', seq: 2, text: '', lostChars: 7 },
    ]
    await paint({ sessionId: 'session-a', nodes: [...earlier, live] })
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]')).map((item) => item.dataset.nodeId),
    ).toEqual(['u1', 'a1', 'a2'])
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toContain('至少 7 字未保存')
    await paint({ sessionId: 'session-b', nodes: [] })
    expect(host.querySelectorAll('[data-node-id]')).toHaveLength(0)
  })

  it('full messageRepository import carries a history prepend and session reset', async () => {
    const live: UINode = { kind: 'assistant', id: 'a2', seq: 4, text: 'latest' }
    await paint({ sessionId: 'session-a', nodes: [live] }, undefined, undefined, 'repository')
    const earlier: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'earlier' }] },
      { kind: 'assistant', id: 'a1', seq: 2, text: '', lostChars: 7 },
    ]
    await paint({ sessionId: 'session-a', nodes: [...earlier, live] }, undefined, undefined, 'repository')
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]')).map((item) => item.dataset.nodeId),
    ).toEqual(['u1', 'a1', 'a2'])
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toContain('至少 7 字未保存')
    await paint({ sessionId: 'session-b', nodes: [] }, undefined, undefined, 'repository')
    expect(host.querySelectorAll('[data-node-id]')).toHaveLength(0)
  })
})

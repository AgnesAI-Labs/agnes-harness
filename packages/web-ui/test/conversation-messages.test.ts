/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import {
  ConversationMessages,
  type ConversationProjectionStore,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

function Harness({ store }: { store: ConversationProjectionStore }) {
  const runtime = useConversationRuntime(store)
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(ConversationMessages))
}

async function mount(store: ConversationProjectionStore) {
  await act(async () => root.render(createElement(Harness, { store })))
}

async function update(store: ConversationProjectionStore, nodes: readonly UINode[]) {
  await act(async () => store.update({ sessionId: 'session', nodes }))
}

const item = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
const ids = () =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-node-id]')).map((node) => node.dataset.nodeId)

const nodes: UINode[] = [
  { kind: 'context', id: 'ctx', seq: 1, text: 'private context' },
  {
    kind: 'user',
    id: 'user',
    seq: 2,
    content: [
      { type: 'text', text: '第一行' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'text', text: '第二行' },
    ],
  },
  { kind: 'assistant', id: 'assistant', seq: 3, thinking: '思考中', text: '回答 **正文**', streaming: true },
  {
    kind: 'tool',
    id: 'tool',
    seq: 4,
    toolUseId: 'call',
    name: 'read_file',
    status: 'running',
    summary: '读取文档',
    argsPreview: '{"path":"README.md"}',
  },
  {
    kind: 'approval',
    id: 'approval',
    seq: 5,
    state: 'pending',
    summary: '执行写入',
    risk: 'destructive',
    options: ['allow_once', 'reject_once'],
  },
  { kind: 'cost', id: 'cost', seq: 6, source: 'estimated' },
  {
    kind: 'artifact',
    id: 'artifact',
    seq: 7,
    name: 'report.md',
    ref: { sha256: 'a'.repeat(64), size: 3, mime: 'text/markdown' },
  },
  { kind: 'compaction', id: 'compaction', seq: 8, range: [1, 6] },
  { kind: 'slot', id: 'slot', fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: {} } },
  { kind: 'contribute-conflict', id: 'conflict', seq: 9, key: 'memory', ops: ['replace', 'append'] },
  { kind: 'context-sections', id: 'sections', seq: 10, sections: [] },
]

describe('W3b projected message DOM', () => {
  it('keeps the thinking disclosure stable across stream updates and after manual reopening', async () => {
    const thinkingNode: UINode = {
      kind: 'assistant',
      id: 'thinking',
      seq: 1,
      thinking: '第一步',
      text: '',
      streaming: true,
    }
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [thinkingNode] })
    await mount(store)
    const disclosure = item('thinking')?.querySelector<HTMLDetailsElement>('details.thinking')
    expect(disclosure?.open).toBe(true)
    if (disclosure) disclosure.open = false
    await update(store, [{ ...thinkingNode, thinking: '第二步' }])
    expect(item('thinking')?.querySelector('details.thinking')).toBe(disclosure)
    expect(disclosure?.open).toBe(false)
    await update(store, [{ ...thinkingNode, thinking: '完成推理', text: '正文' }])
    expect(disclosure?.open).toBe(false)
    if (disclosure) disclosure.open = true
    await update(store, [{ ...thinkingNode, thinking: '完成推理', text: '最终正文', streaming: false }])
    expect(disclosure?.open).toBe(true)
  })

  it('renders all nine visible kinds in source order and retains the two context nodes in the full projection', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes })
    await mount(store)
    expect(ids()).toEqual([
      'user',
      'assistant',
      'tool',
      'approval',
      'cost',
      'artifact',
      'compaction',
      'slot',
      'conflict',
    ])
    expect(item('user')?.textContent).toContain('第一行\n第二行')
    expect(item('assistant')?.textContent).toContain('思考中')
    expect(item('assistant')?.textContent).toContain('回答 **正文**')
    expect(item('tool')?.textContent).toContain('正在执行')
    expect(item('approval')?.textContent).toContain('需要你确认')
    expect(item('cost')?.textContent).toContain('费用未提供')
    expect(item('artifact')?.textContent).toContain('report.md')
    expect(item('compaction')?.textContent).toContain('已整理上下文（范围：1–6）')
    expect(item('slot')?.textContent).toContain('此卡片的插件未就绪')
    expect(item('conflict')?.textContent).toContain('memory：replace、append')
    expect(item('conflict')?.getAttribute('role')).toBe('note')
    expect(item('ctx')).toBeNull()
    expect(item('sections')).toBeNull()
    expect(store.getSnapshot().nodes).toBe(nodes)
  })

  it('updates each kind by ID, preserves disclosure state, and removes deleted nodes', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes })
    await mount(store)
    const originals = new Map(ids().map((id) => [id, item(id as string)]))
    const thinking = item('assistant')?.querySelector<HTMLDetailsElement>('details.thinking')
    expect(thinking?.open).toBe(false)
    const toolButton = item('tool')?.querySelector<HTMLButtonElement>('button.tool-detail')
    await act(async () => toolButton?.click())
    expect(toolButton?.getAttribute('aria-expanded')).toBe('true')
    const cost = item('cost')?.querySelector<HTMLDetailsElement>('details.call-usage')
    if (cost) cost.open = true

    const settled: UINode[] = nodes.map((node): UINode => {
      switch (node.kind) {
        case 'user':
          return { ...node, content: [{ type: 'text', text: '新问题' }] }
        case 'assistant':
          return { ...node, thinking: '推理完成', text: '最终回答', streaming: false }
        case 'tool':
          return { ...node, status: 'failed', summary: '读取失败', resultPreview: 'Permission denied' }
        case 'approval':
          return { ...node, state: 'decided', decision: { verdict: 'rejected', via: 'user' } }
        case 'cost':
          return {
            ...node,
            source: 'gateway',
            credits: 1.25,
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          }
        case 'artifact':
          return { ...node, name: 'final.md' }
        case 'compaction':
          return { ...node, summary: '已归档早期记录' }
        case 'slot':
          return { ...node, fill: { ...node.fill, payload: { current: 2 } } }
        case 'contribute-conflict':
          return { ...node, key: 'policy', ops: ['remove'] }
        default:
          return node
      }
    })
    await update(store, settled)
    for (const [id, original] of originals) expect(item(id as string)).toBe(original)
    expect(item('user')?.textContent).toContain('新问题')
    expect(item('assistant')?.textContent).toContain('最终回答')
    expect(item('assistant')?.dataset.streaming).toBe('false')
    expect(item('tool')?.getAttribute('aria-label')).toBe('工具 read_file：执行失败')
    expect(item('tool')?.textContent).toContain('Permission denied')
    expect(toolButton?.getAttribute('aria-expanded')).toBe('true')
    expect(item('approval')?.getAttribute('aria-label')).toBe('审批：已拒绝')
    expect(item('approval')?.querySelectorAll('button')).toHaveLength(0)
    expect(item('cost')?.textContent).toContain('1.25 credits（网关记录）')
    expect(cost?.open).toBe(true)
    expect(item('artifact')?.textContent).toContain('final.md')
    expect(item('compaction')?.textContent).toContain('已归档早期记录')
    expect(item('conflict')?.textContent).toContain('policy：remove')
    await update(
      store,
      settled.filter((node) => node.kind === 'user' || node.kind === 'assistant'),
    )
    expect(ids()).toEqual(['user', 'assistant'])
    expect(item('tool')).toBeNull()
  })

  it('shows lost output, terminal failure and expiry without inventing authorization controls', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        { kind: 'assistant', id: 'lost', seq: 1, text: '', lostChars: 42 },
        {
          kind: 'tool',
          id: 'waiting',
          seq: 2,
          toolUseId: 'c',
          name: 'shell',
          status: 'awaiting_approval',
          summary: '等待确认',
        },
        {
          kind: 'approval',
          id: 'expired',
          seq: 3,
          state: 'expired',
          summary: '命令审批',
          risk: 'unknown',
          options: [],
        },
      ],
    })
    await mount(store)
    expect(item('lost')?.textContent).toContain('输出中断，至少 42 字未保存')
    expect(item('waiting')?.textContent).toContain('等待审批')
    expect(item('expired')?.getAttribute('aria-label')).toBe('审批：审批已过期')
    expect(host.querySelectorAll('button')).toHaveLength(1)
    await update(store, [
      { kind: 'assistant', id: 'lost', seq: 1, text: 'recovered', streaming: false },
      {
        kind: 'tool',
        id: 'waiting',
        seq: 2,
        toolUseId: 'c',
        name: 'shell',
        status: 'completed',
        summary: '完成',
      },
    ])
    expect(item('lost')?.textContent).toContain('recovered')
    expect(item('waiting')?.textContent).toContain('执行完成')
  })
})

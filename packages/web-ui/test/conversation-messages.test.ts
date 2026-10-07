/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import {
  ConversationMarkdown,
  ConversationMessages,
  type ConversationMessagesProps,
  type ConversationProjectionStore,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webUiLocaleCatalog } from '../src/locales/index.js'

let host: HTMLDivElement
let root: Root
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

const t: ConversationMessagesProps['t'] = (key, vars) =>
  Object.entries(vars ?? {}).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
    webUiLocaleCatalog['zh-CN'][key] ?? key,
  )

function Harness({
  store,
  renderMarkdown,
}: {
  store: ConversationProjectionStore
  renderMarkdown?: ConversationMessagesProps['renderMarkdown']
}) {
  const runtime = useConversationRuntime(store)
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(ConversationMessages, { t, ...(renderMarkdown ? { renderMarkdown } : {}) }),
  )
}

async function mount(
  store: ConversationProjectionStore,
  renderMarkdown?: ConversationMessagesProps['renderMarkdown'],
) {
  await act(async () => root.render(createElement(Harness, { store, renderMarkdown })))
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
      { type: 'file', data: 'YWJj', name: '<script>附件.txt</script>', mimeType: 'text/plain' },
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
  it('renders ordinary message content through assistant-ui message parts', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        { kind: 'user', id: 'user-1', seq: 1, content: [{ type: 'text', text: 'Question' }] },
        {
          kind: 'assistant',
          id: 'assistant-1',
          seq: 2,
          thinking: 'Checking the result',
          text: 'Streaming answer',
          streaming: true,
        },
      ],
    })
    await mount(store)

    const user = item('user-1')?.querySelector('[data-agnes-assistant-ui-message="user"]')
    const assistant = item('assistant-1')?.querySelector('[data-agnes-assistant-ui-message="assistant"]')
    expect(user).not.toBeNull()
    expect(user?.textContent).toContain('Question')
    expect(assistant?.querySelector('[data-assistant-ui-part="reasoning"]')?.textContent).toContain(
      'Checking the result',
    )
    expect(assistant?.querySelector('[data-assistant-ui-part="text"]')?.textContent).toContain(
      'Streaming answer',
    )
  })

  it('keeps a long fenced code line inside the assistant message width', async () => {
    const line = 'A'.repeat(400)
    const source = `\`\`\`text\n${line}\n\`\`\``
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [{ kind: 'assistant', id: 'wide-code', seq: 1, text: source }],
    })
    await mount(store, (text, part) => createElement(ConversationMarkdown, { source: text, part, t }))

    const content = item('wide-code')?.querySelector<HTMLElement>('.aui-assistant-message-content')
    expect(item('wide-code')?.querySelector('pre code')?.textContent?.trimEnd()).toBe(line)
    expect(content?.classList.contains('aui:self-stretch')).toBe(true)
    expect(content?.classList.contains('aui:min-w-0')).toBe(true)
  })

  it('renders messages projected after the read-only runtime starts empty', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [] })
    await mount(store)
    await update(store, [
      { kind: 'user', id: 'user-after-start', seq: 1, content: [{ type: 'text', text: 'Question' }] },
      { kind: 'assistant', id: 'assistant-after-start', seq: 2, text: 'Answer' },
    ])

    expect(item('user-after-start')?.querySelector('[data-assistant-ui-part="text"]')?.textContent).toBe(
      'Question',
    )
    expect(item('assistant-after-start')?.querySelector('[data-assistant-ui-part="text"]')?.textContent).toBe(
      'Answer',
    )
  })

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
    expect(item('user')?.textContent).toContain('图片无法显示')
    expect(item('assistant')?.textContent).toContain('思考中')
    expect(item('assistant')?.textContent).toContain('回答 **正文**')
    expect(item('tool')?.textContent).toContain('正在执行')
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).not.toBeNull()
    expect(item('tool')?.querySelector('.tool-detail-inner .tool-detail-text')?.textContent).toContain(
      '执行参数',
    )
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

  it('rebuilds a persisted image preview in both DOM copies and releases its URL when the row leaves', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:history-image'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const user: UINode = {
      kind: 'user',
      id: 'persisted-image',
      seq: 1,
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        },
      ],
    }
    user.content = Array.from({ length: 5 }, () => user.content[0] as (typeof user.content)[number])
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [user] })
    await mount(store)
    const article = item('persisted-image')
    // 门户那份是界面上真正显示的内容，兜底只是被 CSS 隐藏的备份：图只出现在兜底里等于没显示。
    const portal = article?.querySelector<HTMLElement>('[data-agnes-assistant-ui-target]')
    expect(portal?.dataset.agnesAssistantUiReady).toBe('true')
    expect(portal?.querySelectorAll('img.user-message-image')).toHaveLength(5)
    const thumbnail = portal?.querySelector<HTMLImageElement>('img.user-message-image')
    expect(thumbnail?.src).toBe('blob:history-image')
    // 固定缩略图尺寸，不跟着原图比例走：否则竖长图会把消息撑成一根。
    expect([thumbnail?.getAttribute('width'), thumbnail?.getAttribute('height')]).toEqual(['72', '56'])
    expect(article?.querySelector<HTMLImageElement>('img.user-message-image')?.src).toBe('blob:history-image')
    await update(store, [])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-image')
  })

  it('keeps the attachment block above the message text in both DOM copies', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes })
    await mount(store)
    const article = item('user')
    for (const copy of ['[data-agnes-assistant-ui-target]', '[data-agnes-assistant-ui-fallback]']) {
      expect(article?.querySelector(`${copy} .user-message-files`)?.textContent).toContain(
        '<script>附件.txt</script>',
      )
      expect(article?.querySelector(`${copy} .user-message-files script`)).toBeNull()
      const images = article?.querySelector(`${copy} .user-message-images`) as Element
      const text = article?.querySelector(`${copy} .node-body`) as Element
      expect(images).not.toBeNull()
      expect(text).not.toBeNull()
      // DOCUMENT_POSITION_FOLLOWING：正文排在图片块之后，图片才算是独立的一块。
      expect(images.compareDocumentPosition(text)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
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
    expect(item('tool')?.dataset.expanded).toBe('true')
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
    expect(item('tool')?.dataset.expanded).toBe('true')
    expect(item('approval')?.getAttribute('aria-label')).toBe('已拒绝')
    await update(
      store,
      settled.map((node) =>
        node.kind === 'approval'
          ? { ...node, decision: { verdict: 'unavailable', via: 'sync', reason: 'no_approver' } }
          : node,
      ),
    )
    expect(item('approval')?.getAttribute('aria-label')).toBe('无人审批，未执行')
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

  it('names a failed shell call by its exit code and shows what it printed as output', async () => {
    const shell = (
      id: string,
      name: string,
      resultPreview: string,
      status: 'failed' | 'completed' = 'failed',
    ): UINode => ({
      kind: 'tool',
      id,
      seq: 1,
      toolUseId: id,
      name,
      status,
      summary: '失败',
      resultPreview,
    })
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        shell('exit', 'shell', 'hello\n[exit 1]'),
        shell('silent', 'shell', '[exit 2] [output truncated by sandbox]'),
        shell('cut', 'shell', 'partial output with no exit line'),
        shell('other', 'read', 'x\n[exit 3]'),
        // A timed-out call ends with its marker and has no exit line, so it keeps the general wording.
        shell(
          'timeout',
          'shell',
          'part\n[exit 1]\n[timed out after 118000ms: the command and the processes in its process group were killed]',
        ),
        shell('done', 'shell', 'fine\n[exit 0]', 'completed'),
      ],
    })
    await mount(store)
    const detail = (id: string) => item(id)?.querySelector('.tool-detail-text')?.textContent
    expect(item('exit')?.getAttribute('aria-label')).toBe('工具 shell：退出码 1')
    expect(item('exit')?.querySelector('.tool-status')?.textContent).toBe('退出码 1')
    expect(detail('exit')).toContain('执行结果\nhello')
    expect(detail('exit')).not.toContain('[exit 1]')
    expect(detail('exit')).not.toContain('错误详情')
    expect(detail('silent')).toContain('执行结果\n（无输出）')
    expect(item('silent')?.getAttribute('aria-label')).toBe('工具 shell：退出码 2')
    expect(item('cut')?.getAttribute('aria-label')).toBe('工具 shell：执行失败')
    expect(detail('cut')).toContain('错误详情\npartial output')
    expect(item('other')?.getAttribute('aria-label')).toBe('工具 read：执行失败')
    expect(item('timeout')?.getAttribute('aria-label')).toBe('工具 shell：执行失败')
    expect(detail('timeout')).toContain('错误详情\npart')
    expect(detail('timeout')).toContain('[timed out after 118000ms')
    expect(item('done')?.getAttribute('aria-label')).toBe('工具 shell：执行完成')
    expect(detail('done')).toContain('执行结果\nfine\n[exit 0]')
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
    expect(item('expired')?.getAttribute('aria-label')).toBe('审批已过期')
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

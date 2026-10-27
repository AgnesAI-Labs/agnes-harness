/** @vitest-environment happy-dom */

import { attachmentLink, type UINode } from '@agnes/protocol'
import {
  ConversationMarkdown,
  ConversationMessages,
  type ConversationMessagesProps,
  type ConversationProjectionStore,
  ConversationToolCard,
  createConversationProjectionStore,
  useConversationProjection,
} from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { systemInputText } from '../src/conversation/user-presentation.js'
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
  const projection = useConversationProjection(store)
  return createElement(ConversationMessages, {
    t,
    nodes: projection.nodes,
    ...(renderMarkdown ? { renderMarkdown } : {}),
  })
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
  it('announces a localized damaged-tail recovery with its diagnostic id', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        {
          kind: 'ledger-recovery',
          id: 'recovery',
          seq: 10,
          validThroughSeq: 9,
          diagnosticId: 'tail-diagnostic',
        },
      ],
    })
    await mount(store)
    const notice = host.querySelector('[data-testid="ledger-tail-recovery-notice"]')
    expect(notice?.getAttribute('role')).toBe('status')
    expect(notice?.textContent).toBe(
      t('timeline.ledgerRecovery', { seq: 9, diagnosticId: 'tail-diagnostic' }),
    )
    expect(notice?.textContent).toContain('tail-diagnostic')
    expect(notice?.textContent).not.toContain('timeline.ledgerRecovery')
  })

  it('quietly names tool sources a turn started without and memory changed outside its provider', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        { kind: 'tool-source-pending', id: 'pending', seq: 3, sources: ['Tracker', 'Wiki'] },
        { kind: 'memory-external-change', id: 'memory', seq: 4, paths: ['MEMORY.md', 'style.md'] },
      ],
    })
    await mount(store)
    const notice = host.querySelector('[data-testid="tool-source-pending-notice"]')
    expect(notice?.getAttribute('role')).toBe('status')
    expect(notice?.textContent).toBe(
      t('timeline.toolSourcePending', { names: `Tracker${t('timeline.conflictOpsJoiner')}Wiki` }),
    )
    const memory = host.querySelector('[data-testid="memory-external-change-notice"]')
    expect(memory?.getAttribute('role')).toBe('status')
    expect(memory?.textContent).toBe(
      t('timeline.memoryExternalChange', {
        names: `MEMORY.md${t('timeline.conflictOpsJoiner')}style.md`,
      }),
    )
  })

  it('says whether a turn undo restored, stopped or was refused', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        { kind: 'workspace-undo', id: 'u1', seq: 3, turn: 2, restored: 3, failed: 0, conflicts: 0 },
        { kind: 'workspace-undo', id: 'u2', seq: 4, turn: 2, restored: 1, failed: 2, conflicts: 0 },
        { kind: 'workspace-undo', id: 'u3', seq: 5, turn: 2, restored: 0, failed: 0, conflicts: 1 },
      ],
    })
    await mount(store)
    const texts = [...host.querySelectorAll('[data-testid="workspace-undo-notice"]')].map(
      (n) => n.textContent,
    )
    expect(texts).toEqual([
      t('timeline.workspaceUndone', { turn: 2, count: 3 }),
      t('timeline.workspaceUndoPartial', { turn: 2, restored: 1, failed: 2 }),
      t('timeline.workspaceUndoRefused', { turn: 2, count: 1 }),
    ])
  })

  it('renders ordinary message content once, in the node article', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        {
          kind: 'user',
          origin: 'system',
          id: 'user-1',
          seq: 1,
          content: [
            { type: 'text', text: 'Question' },
            {
              type: 'text',
              text: 'UNTRUSTED REFERENCE: hidden excerpt',
              reference: {
                source: 'session',
                id: 'previous/session',
                label: '<script>Previous</script>',
                hash: 'a'.repeat(64),
                truncated: true,
              },
            },
          ],
        },
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

    const user = item('user-1')
    const assistant = item('assistant-1')
    expect(user).not.toBeNull()
    expect(user?.querySelectorAll('.node-body')).toHaveLength(1)
    expect(assistant?.querySelectorAll('.node-body')).toHaveLength(1)
    expect(user?.textContent).toContain('Question')
    expect(user?.textContent).not.toContain('hidden excerpt')
    expect(user?.querySelector('[data-testid="reference-session-link"]')?.getAttribute('href')).toBe(
      '?session=previous%2Fsession',
    )
    expect(user?.querySelector('[data-testid="reference-sent-chip"]')?.textContent).toContain('摘录已截断')
    expect(user?.querySelector('script')).toBeNull()
    expect(assistant?.querySelector('.thinking')?.textContent).toContain('Checking the result')
    expect(assistant?.querySelector('.node-body')?.textContent).toContain('Streaming answer')
  })

  it('draws the reader on the right in one bubble and leaves every other row without a bubble', async () => {
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [
        { kind: 'user', id: 'said', seq: 1, content: [{ type: 'text', text: 'Question' }] },
        { kind: 'assistant', id: 'answer', seq: 2, text: 'Answer' },
        {
          kind: 'user',
          origin: 'system',
          id: 'status',
          seq: 3,
          content: [{ type: 'text', text: 'done' }],
          system: { source: 'agnes/child', type: 'child-completed', summary: 'done', data: {} },
        },
      ],
    })
    await mount(store)
    const list = host.querySelector('[data-agnes-conversation-messages] .ant-bubble-list')
    expect(list).not.toBeNull()
    // The transcript region owns scrolling; the list must not flip into its own bottom-anchored mode.
    expect(list?.querySelector('.ant-bubble-list-autoscroll')).toBeNull()
    const bubble = (id: string) => item(id)?.closest('.ant-bubble')
    expect(bubble('said')?.classList.contains('ant-bubble-end')).toBe(true)
    expect(bubble('said')?.querySelector('.ant-bubble-content-filled')).not.toBeNull()
    for (const id of ['answer', 'status']) {
      expect(bubble(id)?.classList.contains('ant-bubble-start')).toBe(true)
      expect(bubble(id)?.querySelector('.ant-bubble-content-borderless')).not.toBeNull()
      expect(bubble(id)?.querySelector('.ant-bubble-content-filled')).toBeNull()
    }
    expect(item('status')?.dataset.nodeKind).toBe('system-input')
  })

  it.each([false, true])(
    'opens a tool call with automatic permission evidence=%s from its only step control',
    async (automatic) => {
      const store = createConversationProjectionStore({
        sessionId: 'session',
        nodes: [
          {
            kind: 'tool',
            id: 'step',
            seq: 1,
            toolUseId: 'call',
            name: 'read_file',
            status: 'completed',
            summary: '读取文档',
            resultPreview: 'contents',
            ...(automatic
              ? {
                  permissionDecision: {
                    reason: 'full-access' as const,
                    decisionId: 'decision',
                    actor: { id: 'owner', org: 'local', role: 'system', deptPath: [], attrs: {} },
                  },
                }
              : {}),
          },
        ],
      })
      await mount(store)
      const step = item('step')
      expect(step?.querySelectorAll('button')).toHaveLength(1)
      const head = step?.querySelector<HTMLButtonElement>('[data-testid="tool-detail-toggle"]')
      // One line: verb · target. A finished step says nothing about its status.
      expect(head?.classList.contains('activity-row')).toBe(true)
      expect(head?.querySelector('.tool-name')?.textContent).toBe('读取')
      expect(head?.querySelector('.activity-target')?.textContent).toBe('读取文档')
      if (automatic) expect(head?.querySelector('.activity-note')?.textContent).toBe('自动允许（完全访问）')
      else expect(head?.querySelector('.activity-note')).toBeNull()
      expect(head?.dataset.state).toBeUndefined()
      expect(head?.getAttribute('aria-expanded')).toBe('false')
      await act(async () => head?.click())
      expect(head?.getAttribute('aria-expanded')).toBe('true')
      expect(step?.querySelector('.tool-detail-body')?.getAttribute('aria-hidden')).toBe('false')
    },
  )

  it('keeps a long fenced code line inside the assistant message width', async () => {
    const line = 'A'.repeat(400)
    const source = `\`\`\`text\n${line}\n\`\`\``
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [{ kind: 'assistant', id: 'wide-code', seq: 1, text: source }],
    })
    await mount(store, (text, part) => createElement(ConversationMarkdown, { source: text, part, t }))

    expect(item('wide-code')?.querySelectorAll('pre code')).toHaveLength(1)
    expect(item('wide-code')?.querySelector('pre code')?.textContent?.trimEnd()).toBe(line)
    expect(item('wide-code')?.querySelector('.node-body.markdown pre')).not.toBeNull()
  })

  it('renders messages projected after the store starts empty', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [] })
    await mount(store)
    await update(store, [
      { kind: 'user', id: 'user-after-start', seq: 1, content: [{ type: 'text', text: 'Question' }] },
      { kind: 'assistant', id: 'assistant-after-start', seq: 2, text: 'Answer' },
    ])

    expect(item('user-after-start')?.querySelector('.node-body')?.textContent).toBe('Question')
    expect(item('assistant-after-start')?.querySelector('.node-body')?.textContent).toBe('Answer')
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
    const disclosure = item('thinking')?.querySelector<HTMLElement>('.thinking')
    const toggle = disclosure?.querySelector<HTMLButtonElement>('[data-testid="thinking-toggle"]')
    const content = disclosure?.querySelector<HTMLElement>('.thinking-content')
    const open = () => [disclosure?.dataset.expanded, toggle?.getAttribute('aria-expanded'), content?.hidden]
    expect(open()).toEqual(['true', 'true', false])
    await act(async () => toggle?.click())
    await update(store, [{ ...thinkingNode, thinking: '第二步' }])
    expect(item('thinking')?.querySelector('.thinking')).toBe(disclosure)
    expect(item('thinking')?.querySelector('.thinking-content')).toBe(content)
    expect(content?.textContent).toContain('第二步')
    expect(open()).toEqual(['false', 'false', true])
    await update(store, [{ ...thinkingNode, thinking: '完成推理', text: '正文' }])
    expect(open()).toEqual(['false', 'false', true])
    await act(async () => toggle?.click())
    await update(store, [{ ...thinkingNode, thinking: '完成推理', text: '最终正文', streaming: false }])
    expect(open()).toEqual(['true', 'true', false])
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
    // A running step shimmers instead of saying so; its name still reaches assistive technology.
    expect(item('tool')?.querySelector('.activity-row')?.getAttribute('data-state')).toBe('running')
    expect(item('tool')?.getAttribute('aria-label')).toContain('正在执行')
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).not.toBeNull()
    expect(
      item('tool')?.querySelector('.tool-detail-inner [data-testid="tool-detail-text"]')?.textContent,
    ).toContain('原始参数')
    // The one-line clipped JSON is re-indented for reading; the values themselves are untouched.
    expect(item('tool')?.querySelector('[data-testid="tool-raw-args"]')?.textContent).toBe(
      '{\n  "path": "README.md"\n}',
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

  it('rebuilds a persisted image preview once and releases its URL when the row leaves', async () => {
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
    // 一条消息只有一棵 DOM：五张图就是五个缩略图，不存在隐藏的第二份。
    expect(article?.querySelectorAll('img.user-message-image')).toHaveLength(5)
    const thumbnail = article?.querySelector<HTMLImageElement>('img.user-message-image')
    expect(thumbnail?.src).toBe('blob:history-image')
    // 固定缩略图尺寸，不跟着原图比例走：否则竖长图会把消息撑成一根。
    expect([thumbnail?.getAttribute('width'), thumbnail?.getAttribute('height')]).toEqual(['72', '56'])
    await update(store, [])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-image')
  })

  it('keeps the attachment block above the message text', async () => {
    const content = nodes.map((node) =>
      node.kind === 'user'
        ? {
            ...node,
            content: [
              ...node.content,
              {
                type: 'resource_link' as const,
                uri: `artifact://${'a'.repeat(64)}`,
                name: 'stored-original.pdf',
                mimeType: 'application/pdf',
              },
            ],
          }
        : node,
    )
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: content })
    await mount(store)
    const article = item('user')
    expect(article?.querySelectorAll('.user-message-files')).toHaveLength(1)
    expect(article?.querySelector('.user-message-files')?.textContent).toContain('<script>附件.txt</script>')
    expect(article?.querySelector('.user-message-files script')).toBeNull()
    expect(article?.querySelector('.user-message-files')?.textContent).toContain('stored-original.pdf')
    expect(article?.querySelector('[href^="artifact://"]')).toBeNull()
    const images = article?.querySelector('.user-message-images') as Element
    const text = article?.querySelector('.node-body') as Element
    expect(images).not.toBeNull()
    expect(text).not.toBeNull()
    // DOCUMENT_POSITION_FOLLOWING：正文排在图片块之后，图片才算是独立的一块。
    expect(images.compareDocumentPosition(text)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('updates each kind by ID, preserves disclosure state, and removes deleted nodes', async () => {
    const store = createConversationProjectionStore({ sessionId: 'session', nodes })
    await mount(store)
    const originals = new Map(ids().map((id) => [id, item(id as string)]))
    const thinking = item('assistant')?.querySelector<HTMLElement>('.thinking')
    expect(thinking?.dataset.expanded).toBe('false')
    const toolButton = item('tool')?.querySelector<HTMLButtonElement>('button.tool-detail')
    await act(async () => toolButton?.click())
    expect(toolButton?.getAttribute('aria-expanded')).toBe('true')
    expect(item('tool')?.dataset.expanded).toBe('true')
    const cost = item('cost')?.querySelector<HTMLElement>('.agh-disclosure.call-usage')
    await act(async () => cost?.querySelector<HTMLElement>('.agh-disclosure-summary')?.click())

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
          ? { ...node, decision: { verdict: 'unavailable', via: 'sync', reason: 'no-approver' } }
          : node,
      ),
    )
    expect(item('approval')?.getAttribute('aria-label')).toBe('无人审批，未执行')
    await update(
      store,
      settled.map((node) =>
        node.kind === 'approval'
          ? {
              ...node,
              purpose: 'business.confirm',
              decision: {
                verdict: 'allowed-once',
                via: 'full-access',
                reason: 'full-access',
                byLabel: 'human.qa',
              },
            }
          : node,
      ),
    )
    expect(item('approval')?.textContent).toContain('完全访问下自动确认 · human.qa')
    // The record of an approval only unfolds its own text; it offers no decision.
    expect(item('approval')?.querySelectorAll('button:not([data-testid="approval-step"])')).toHaveLength(0)
    expect(item('approval')?.querySelector('[data-approval-action]')).toBeNull()
    expect(item('cost')?.textContent).toContain('1.25 credits（网关记录）')
    expect(cost?.dataset.open).toBe('true')
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
    const detail = (id: string) => item(id)?.querySelector('[data-testid="tool-detail-text"]')?.textContent
    expect(item('exit')?.getAttribute('aria-label')).toBe('工具 运行命令：退出码 1')
    expect(item('exit')?.querySelector('.tool-status')?.textContent).toBe('退出码 1')
    expect(detail('exit')).toContain('标准输出hello')
    expect(detail('exit')).not.toContain('[exit 1]')
    expect(detail('exit')).not.toContain('错误详情')
    expect(detail('silent')).toContain('（无输出）')
    expect(item('silent')?.getAttribute('aria-label')).toBe('工具 运行命令：退出码 2')
    expect(item('cut')?.getAttribute('aria-label')).toBe('工具 运行命令：执行失败')
    expect(detail('cut')).toContain('标准输出partial output')
    expect(item('other')?.getAttribute('aria-label')).toBe('工具 读取：执行失败')
    expect(item('timeout')?.getAttribute('aria-label')).toBe('工具 运行命令：执行失败')
    expect(detail('timeout')).toContain('标准输出part')
    expect(detail('timeout')).toContain('[timed out after 118000ms')
    expect(item('done')?.getAttribute('aria-label')).toBe('工具 运行命令：执行完成')
    expect(detail('done')).toContain('标准输出fine退出码 0')
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
    expect([...host.querySelectorAll('button')].map((button) => button.getAttribute('data-testid'))).toEqual([
      'tool-detail-toggle',
      'approval-step',
    ])
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
    // Success is silent on the row and still named for assistive technology.
    expect(item('waiting')?.querySelector('.activity-note')).toBeNull()
    expect(item('waiting')?.getAttribute('aria-label')).toContain('执行完成')
  })
})

it.each([
  ['completed', '后台任务已完成：Audit'],
  ['failed', '后台任务失败：Audit'],
  ['cancelled', '后台任务已取消：Audit'],
  ['budget_stopped', '后台任务已达到预算上限而停止：Audit'],
] as const)(
  'shows a localized child completion status line (%s) with the result expandable',
  async (status, summary) => {
    const node: UINode = {
      kind: 'user',
      id: 'child',
      seq: 1,
      content: [{ type: 'text', text: 'Background child finished' }],
      origin: 'system',
      system: {
        source: 'agnes/child',
        type: 'child-completed',
        summary: 'Background child finished',
        data: { childKey: 'c1', status, result: 'child-result-text' },
        presentation: { kind: 'child-completed', status, label: 'Audit' },
      },
    }
    const store = createConversationProjectionStore({ sessionId: 's', nodes: [node] })
    await act(async () => root.render(createElement(Harness, { store })))
    expect(host.querySelector('[role=status]')?.textContent).toBe(summary)
    expect(host.querySelector('.system-input-trace pre')?.textContent).toContain('child-result-text')
  },
)

it.each([
  ['succeeded', '已提交：name、email'],
  ['failed', '操作失败：Submit'],
  ['rejected', '操作未执行：Submit'],
] as const)(
  'shows a localized UI receipt summary (%s) while rendering a status line and expandable machine trace',
  async (status, summary) => {
    const node: UINode = {
      kind: 'user',
      id: 'receipt',
      seq: 1,
      content: [{ type: 'text', text: 'UI action completed' }],
      origin: 'system',
      system: {
        source: 'agnes/intelligent-ui',
        type: 'action-result',
        summary: 'UI action completed',
        data: { commandId: 'machine-only' },
        presentation: {
          kind: 'ui-action',
          operation: 'submit',
          status,
          label: 'Submit',
          fields: ['name', 'email'],
        },
      },
    }
    const store = createConversationProjectionStore({ sessionId: 's', nodes: [node] })
    await act(async () => root.render(createElement(Harness, { store })))
    expect(host.textContent).toContain(summary)
    expect(host.querySelector('[role=status]')?.textContent).toBe(summary)
    expect(host.querySelector('.system-input-trace')?.hasAttribute('open')).toBe(false)
    expect(host.querySelector('.system-input-trace pre')?.textContent).toContain('machine-only')
    expect(host.querySelector('[data-node-kind="user"]')).toBeNull()
    expect(host.querySelector('[data-node-kind="system-input"]')).not.toBeNull()
    const english = (key: string, vars?: Record<string, string | number>) =>
      Object.entries(vars ?? {}).reduce(
        (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
        webUiLocaleCatalog.en[key] ?? key,
      )
    expect(node.kind === 'user' && node.system ? systemInputText(node.system, english) : undefined).toBe(
      status === 'succeeded'
        ? 'Submitted: name, email'
        : status === 'failed'
          ? 'Action failed: Submit'
          : 'Action declined: Submit',
    )
  },
)

describe('reconciliation and calls that never ran', () => {
  it('records a reconciliation as the fact confirmed, never as a permission granted', async () => {
    const asked: UINode = {
      kind: 'approval',
      id: 'reconcile',
      seq: 5,
      state: 'pending',
      summary: 'did mcp_manage happen? allowed = it happened, rejected = it did not',
      risk: 'unknown',
      options: ['allow_once', 'reject_once'],
      reconcile: { tool: 'mcp_manage' },
    }
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [asked] })
    await mount(store)
    const row = () => item('reconcile')
    expect(row()?.querySelector('.tool-status')?.textContent).toBe('等你确认是否执行了')
    expect(row()?.querySelector('.approval-summary')?.textContent).toBe(
      '这个操作执行了吗？mcp_manage 已经发出，但没收到结果',
    )
    expect(row()?.textContent).not.toContain('did mcp_manage happen')
    await update(store, [
      { ...asked, state: 'decided', decision: { verdict: 'allowed-session', via: 'human' } } as UINode,
    ])
    expect(row()?.querySelector('.tool-status')?.textContent).toBe('你确认：执行了')
    expect(row()?.getAttribute('aria-label')).toBe('你确认：执行了')
    expect(row()?.textContent).not.toContain('已允许本会话执行')
    await update(store, [
      {
        ...asked,
        state: 'decided',
        decision: { verdict: 'rejected', via: 'human', reason: 'user-rejected' },
      } as UINode,
    ])
    expect(row()?.querySelector('.tool-status')?.textContent).toBe('你确认：没执行')
    // «It did not run» is a fact, not a refusal: the row is not drawn as cancelled.
    expect(row()?.querySelector('[data-state="cancelled"]')).toBeNull()
  })

  it('keeps a literal path target out of translation', async () => {
    const read: Extract<UINode, { kind: 'tool' }> = {
      kind: 'tool',
      id: 'read-review',
      seq: 8,
      toolUseId: 'call-3',
      name: 'read',
      status: 'completed',
      summary: 'read review.ts',
      argsPreview: '{"path":"review.ts"}',
    }
    await act(async () => root.render(createElement(ConversationToolCard, { node: read, t })))
    const target = host.querySelector<HTMLElement>('.activity-target')
    expect(target?.textContent).toBe('review.ts')
    expect([target?.dataset.mono, target?.getAttribute('translate')]).toEqual(['true', 'no'])
  })

  it("says a call the turn never carried out was not run, and keeps a running turn's plan quiet", async () => {
    const planned: Extract<UINode, { kind: 'tool' }> = {
      kind: 'tool',
      id: 'list',
      seq: 6,
      toolUseId: 'call-2',
      name: 'mcp_manage',
      status: 'planned',
      summary: 'mcp_manage',
      argsPreview: '{"action":"list"}',
    }
    await act(async () =>
      root.render(createElement(ConversationToolCard, { node: planned, t, turnStatus: 'waiting' })),
    )
    const card = host.querySelector<HTMLElement>('[data-agnes-tool-card]')
    expect(card?.dataset.notRun).toBe('true')
    expect(card?.textContent).toContain('未执行')
    await act(async () =>
      root.render(createElement(ConversationToolCard, { node: planned, t, turnStatus: 'running' })),
    )
    expect(host.querySelector<HTMLElement>('[data-agnes-tool-card]')?.dataset.notRun).toBeUndefined()
    expect(host.textContent).not.toContain('未执行')
  })
})

it('lazily loads stored image references, downloads originals and releases late URLs after a scope change', async () => {
  const original = { sha256: 'a'.repeat(64), size: 500, mime: 'image/png' }
  const thumbnail = { sha256: 'b'.repeat(64), size: 50, mime: 'image/jpeg' }
  const content = [attachmentLink(original, 'photo.png', { image: { width: 32, height: 24 }, thumbnail })]
  const node: UINode = { kind: 'user', id: 'image-ref', seq: 7, content }
  const release = vi.fn()
  let show: ((entries: { isIntersecting: boolean }[]) => void) | undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: typeof show) {}
      observe(target: HTMLElement) {
        if (target.classList.contains('user-message-attachment')) show = this.callback
      }
      disconnect() {}
    },
  )
  let late: ((value: { url: string; release(): void }) => void) | undefined
  const read = vi.fn(async (artifact: typeof original) => {
    if (artifact.sha256 === thumbnail.sha256) return { url: 'blob:thumbnail', release }
    return new Promise<{ url: string; release(): void }>((resolve) => {
      late = resolve
    })
  })
  try {
    await act(async () =>
      root.render(createElement(ConversationMessages, { t, nodes: [node], readAttachment: read })),
    )
    expect(read).not.toHaveBeenCalled()
    await act(async () => show?.([{ isIntersecting: true }]))
    expect(read.mock.calls.map(([ref]) => ref)).toEqual([thumbnail])
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail')
    expect(host.innerHTML).not.toContain('base64')
    const button = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes('下载原件'))
    await act(async () => button?.click())
    expect(late).toBeTypeOf('function')
    await act(async () =>
      root.render(createElement(ConversationMessages, { key: 'another-session', t, nodes: [] })),
    )
    const releaseLate = vi.fn()
    await act(async () => late?.({ url: 'blob:late-original', release: releaseLate }))
    expect(release).toHaveBeenCalled()
    expect(releaseLate).toHaveBeenCalledOnce()
    expect(host.innerHTML).not.toContain('blob:late-original')
  } finally {
    vi.unstubAllGlobals()
  }
})

it('shows a missing/reclaimed referenced image as unavailable without creating inline image bytes', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(target: HTMLElement) {
        if (target.classList.contains('user-message-attachment'))
          queueMicrotask(() => this.callback([{ isIntersecting: true }]))
      }
      unobserve() {}
      disconnect() {}
    },
  )
  const content = [
    attachmentLink({ sha256: 'a'.repeat(64), size: 9, mime: 'image/png' }, 'missing.png', {
      image: { width: 1, height: 1 },
    }),
  ]
  await act(async () =>
    root.render(
      createElement(ConversationMessages, {
        t,
        nodes: [{ kind: 'user', id: 'missing', seq: 4, content }],
        readAttachment: async () => {
          throw Object.assign(new Error('reclaimed'), { code: 'artifact_reclaimed' })
        },
      }),
    ),
  )
  expect(host.textContent).toContain('图片无法显示')
  expect(host.querySelector('img')).toBeNull()
  vi.unstubAllGlobals()
})

it('uses declared tool intent and scope while keeping commands, identifiers and JSON behind details', async () => {
  const node: UINode = {
    kind: 'tool',
    id: 'human',
    seq: 1,
    toolUseId: 'human',
    name: 'plain_release',
    status: 'completed',
    summary: 'plain_release',
    presentation: { title: '审阅报告', description: '检查来源后提交', summary: '准备签署' },
    argsPreview: JSON.stringify({ object: 'Record-1', command: 'echo secret', cwd: '/private' }),
    resultPreview: 'done',
  }
  await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [node] }))
  const row = item('human')?.querySelector('[data-testid="tool-detail-toggle"]')
  expect(row?.textContent).toContain('审阅报告')
  expect(row?.textContent).toContain('Record-1 · 准备签署')
  expect(row?.textContent).not.toContain('plain_release')
  expect(row?.textContent).not.toContain('secret')
  expect(item('human')?.querySelector('.tool-detail-body')?.getAttribute('aria-hidden')).toBe('true')
  expect(item('human')?.querySelector('[data-testid="tool-detail-text"]')?.textContent).toContain(
    'echo secret',
  )
})

it('separates successful shell environment diagnostics, preserving real stderr and failed output', async () => {
  const { shellOutput } = await import('../src/conversation/messages/shell-output.js')
  const noise = "xcrun: error: couldn't create cache file '/tmp/xcrun_db-1' (errno=Operation not permitted)"
  const text = `count 20\n[stderr]\n${noise}\nscript warning: incomplete row\n[exit 0]`
  expect(
    shellOutput(
      '[stderr]\npython3: warning: confstr() failed with code 5: could not get path of DARWIN_USER_TEMP_DIR; using /tmp instead\n[exit 0]',
    ).environment,
  ).toContain('DARWIN_USER_TEMP_DIR')
  expect(shellOutput(text)).toEqual({
    text: 'count 20\n[stderr]\nscript warning: incomplete row\n[exit 0]',
    environment: noise,
  })
  expect(shellOutput(text.replace('[exit 0]', '[exit 1]'))).toEqual({
    text: text.replace('[exit 0]', '[exit 1]'),
  })
  expect(shellOutput('failure mentions DARWIN_USER_TEMP_DIR\n[exit 0]').environment).toBeUndefined()
  const node: UINode = {
    kind: 'tool',
    id: 'noise',
    seq: 1,
    toolUseId: 'noise',
    name: 'shell',
    status: 'completed',
    summary: 'shell',
    resultPreview: text,
  }
  await mount(createConversationProjectionStore({ sessionId: 'session', nodes: [node] }))
  await act(async () =>
    item('noise')?.querySelector<HTMLButtonElement>('[data-testid="tool-detail-toggle"]')?.click(),
  )
  expect(item('noise')?.querySelector('[data-testid="tool-detail-text"]')?.textContent).toContain(
    'script warning: incomplete row',
  )
  expect(item('noise')?.querySelector('[data-testid="tool-stderr"]')?.textContent).not.toContain('xcrun_db')
  expect(item('noise')?.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
})

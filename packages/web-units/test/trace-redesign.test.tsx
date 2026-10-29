// @vitest-environment happy-dom
import type { FactChainParams, FactChainResult, UINode, UISpan, UITurn } from '@agnes/protocol'
import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { webUiLocaleCatalog } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPane, inspectorPanes } from '../src/trace-inspector.js'
import { highlight, TraceListRow } from '../src/trace-list-row.js'
import { buildControlRows, buildTraceRows, contextLine, type TraceRow } from '../src/trace-model.js'
import { provenanceLinks, TraceSourceRecord } from '../src/trace-provenance.js'
import {
  clampInspectorWidth,
  TRACE_INSPECTOR_DEFAULT_WIDTH,
  TRACE_INSPECTOR_WIDTH_KEY,
  TraceSplitter,
  useInspectorWidth,
} from '../src/trace-splitter.js'
import { summarizeTool } from '../src/trace-summary.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  document.documentElement.lang = ''
  document.body.replaceChildren()
  localStorage.clear()
})

describe('tool summaries', () => {
  it('say what each built-in tool did in words', () => {
    document.documentElement.lang = 'zh-CN'
    const say = (name: string, args: unknown, extra: Record<string, string> = {}) =>
      summarizeTool({ name, argsPreview: JSON.stringify(args), ...extra }).text
    expect(say('read', { path: 'site/portal.html', limit: 80 })).toBe('读取 portal.html（前 80 行）')
    expect(say('read', { path: 'a.md', offset: 10, limit: 5 })).toBe('读取 a.md（第 10–14 行）')
    expect(say('write', { path: 'boot-portal.html', content: 'x'.repeat(2981) })).toBe(
      '写入 boot-portal.html（2,981 字符）',
    )
    expect(say('edit', { path: 'boot-portal.html', edits: [{}, {}] })).toBe('编辑 boot-portal.html（2 处）')
    expect(say('shell', { command: 'npx serve .' })).toBe('运行命令')
    expect(say('ls', { path: '.' }, { status: 'completed', resultPreview: 'a\nb\nc' })).toBe(
      '列出文件 . → 3 项',
    )
    expect(say('ask_user_question', { questions: [{ label: '鞋子类型' }, { label: '交付形式' }] })).toBe(
      '提问 2 个问题：鞋子类型、交付形式',
    )
    expect(say('ui_submit', { answers: { a: 1, b: 2 } })).toBe('提交答案 · 2 个回答')
    expect(say('grep', { pattern: 'TODO' })).toBe('搜索内容「TODO」')
    for (const locale of ['en', 'zh-CN'] as const) {
      document.documentElement.lang = locale
      for (const [key, title] of Object.entries(webUiLocaleCatalog[locale])) {
        if (!key.startsWith('baseTool.')) continue
        const name = key.slice('baseTool.'.length)
        const summary = summarizeTool({ name, summary: 'Run tool · Verify record' }).text
        expect(summary, `${locale} ${name}`).toContain(title)
        expect(summary, `${locale} ${name}`).not.toContain('Run tool')
      }
    }
  })

  it('reads a cut-off argument preview while keeping raw JSON out of the summary', () => {
    const cut = '{"path":"portal.html","content":"<!DOCTYPE html><html lang=\\"zh-CN\\">…'
    expect(summarizeTool({ name: 'write', argsPreview: cut }).text).toBe('Write portal.html')
    const unknown = summarizeTool({ name: 'crm_lookup', summary: 'Find customer', argsPreview: '{"id":7}' })
    expect(unknown).toEqual({ text: 'Find customer' })
  })

  it('turns runtime context JSON into the facts a reader looks for', () => {
    const line = contextLine(
      '[runtime context] {"environment":{"cwd":"~/WorkLLM","model":"deepseek-flash","date":"x"}}',
    )
    expect(line).toEqual({ label: 'Runtime context', detail: 'Working folder ~/WorkLLM · deepseek-flash' })
  })
})

describe('inspector per record kind', () => {
  const at = '2026-10-14T08:57:28.000Z'
  const span = (extra: Partial<UISpan>): UISpan =>
    ({
      id: 's',
      kind: 'other',
      name: '',
      status: 'completed',
      startSeq: 1,
      startedAt: at,
      children: [],
      ...extra,
    }) as UISpan
  const turn = (children: UISpan[]): UITurn =>
    ({
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      startedAt: at,
      status: 'completed',
      nodeIds: [],
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [],
      },
      inherited: false,
      forkable: true,
      trace: span({ id: 'turn', kind: 'turn', children }),
    }) as UITurn

  it('gives each kind its own title and one tab row', () => {
    const tool = {
      kind: 'tool',
      id: 't',
      seq: 2,
      toolUseId: 'c',
      name: 'read',
      status: 'failed',
      summary: 'read',
      argsPreview: '{"path":"a.md"}',
      children: [],
    } as UINode
    const assistant: UINode = { kind: 'assistant', id: 'a', seq: 3, text: 'hi' }
    const rows = buildTraceRows(
      [tool, assistant],
      [
        turn([
          span({ id: 'g', kind: 'generation', model: 'deepseek-flash', nodeIds: ['a'] }),
          span({ id: 'ui-fact:4', name: 'surface.opened · r1 · Questions', startSeq: 4 }),
        ]),
      ],
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('t')?.title).toBe('Read a.md')
    expect(inspectorPanes(byId.get('t')!, false)).toEqual(['result', 'source', 'args'])
    expect(defaultPane(byId.get('t'))).toBe('result')
    expect(byId.get('a')?.title).toBe('Model request · deepseek-flash')
    expect(inspectorPanes(byId.get('a')!, true)).toEqual(['reply', 'request', 'usage', 'source'])
    expect(byId.get('ui-fact:4')?.title).toBe('Opened · Questions')
    expect(inspectorPanes(byId.get('ui-fact:4')!, false)).toEqual(['snapshot', 'actionSteps', 'source'])
  })

  it('puts your controls into the timeline as «Your action» rows with their steps', () => {
    const facts: SessionControlFact[] = [
      {
        seq: 9,
        ts: '2026-10-14T09:03:02Z',
        actor: { kind: 'user', id: 'local' },
        action: 'steer',
        outcome: 'queued',
        details: { itemId: 'i1', item: { content: [{ type: 'text', text: '主色换成深蓝' }] } },
      },
      {
        seq: 12,
        ts: '2026-10-14T09:03:10Z',
        actor: { kind: 'user', id: 'local' },
        action: 'steer',
        outcome: 'delivered',
        details: { itemId: 'i1' },
      },
      {
        seq: 15,
        ts: '2026-10-14T09:04:00Z',
        actor: { kind: 'user', id: 'local' },
        action: 'pause',
        outcome: 'refused',
        details: { admissionId: 'p' },
      },
    ] as unknown as SessionControlFact[]
    document.documentElement.lang = 'zh-CN'
    const rows = buildControlRows(facts)
    expect(rows.map((row) => [row.kind, row.badge, row.title, row.statusCode])).toEqual([
      ['control', '你的操作', '指引：主色换成深蓝', 'completed'],
      ['control', '你的操作', '暂停', 'failed'],
    ])
    expect(rows[0]?.steps?.map((step) => step.label)).toEqual(['已排队', '已送达'])
    expect(inspectorPanes(rows[0]!, false)).toEqual(['steps', 'source'])
  })
})

describe('provenance in the source tab', () => {
  const result = {
    sessionId: 's',
    laneId: 'main',
    atSeq: 9,
    edges: [],
    gaps: [],
    nodes: [
      {
        id: 'r',
        kind: 'request',
        callId: 'call',
        seq: 3,
        model: 'deepseek-flash',
        generationId: 'g',
        derivedHash: null,
        promptHash: null,
        toolSchemaHash: null,
        messagesHash: null,
        memoryRevision: null,
        memoryHash: null,
        hashBasis: 'unavailable',
        incomplete: false,
      },
      {
        id: 'at',
        kind: 'attempt',
        attemptId: 'a',
        parentCallId: 'call',
        index: 0,
        adapterId: 'x',
        status: 'completed',
        wireUnavailable: null,
      },
      { id: 'c', kind: 'composition', compositionHash: 'h', bundles: [] },
      {
        id: 'gen',
        kind: 'generation',
        generationId: 'g',
        packages: [
          { packageId: 'support-triage', version: '1.1.0', snapshotId: '', integrity: '', treeIntegrity: '' },
        ],
      },
    ],
  } as unknown as FactChainResult

  it('lists model, attempt and plugin versions and hides empty links', () => {
    document.documentElement.lang = 'zh-CN'
    expect(provenanceLinks(result, 'call').map((link) => [link.label, link.value])).toEqual([
      ['模型', 'deepseek-flash'],
      ['尝试', '第 1 次，共 1 次 · 已完成'],
      ['请求时插件版本', '1 个插件'],
    ])
  })

  it('reads the chain in place instead of opening the workbench', async () => {
    const reads: unknown[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(TraceSourceRecord, {
          sessionId: 's',
          anchor: { kind: 'request', callId: 'call' },
          read: async (params: FactChainParams) => {
            reads.push(params)
            return result
          },
        }),
      ),
    )
    expect(reads).toEqual([{ sessionId: 's', laneId: 'main', anchor: { kind: 'request', callId: 'call' } }])
    expect(host.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
    expect(host.textContent).not.toContain('exactly once')
    expect(host.querySelector('[data-testid="trace-provenance"]')?.textContent).toContain(
      'support-triage · 1.1.0',
    )
    await act(async () => root.unmount())
  })
})

it('keeps an unknown action outcome visible while folding technical provenance gaps', async () => {
  document.documentElement.lang = 'en'
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const result: FactChainResult = {
    sessionId: 's',
    laneId: 'main',
    atSeq: 3,
    edges: [],
    gaps: [{ at: null, reason: 'ambiguous-link' }],
    nodes: [
      {
        id: 'receipt',
        kind: 'receipt',
        toolUseId: 't',
        resultSeq: 3,
        settledSeq: null,
        isError: null,
        code: null,
        outcome: 'unknown',
        resultKind: 'synthetic',
        partial: false,
        externalOutcome: 'unknown',
      },
    ],
  }
  await act(async () =>
    root.render(
      createElement(TraceSourceRecord, {
        sessionId: 's',
        anchor: { kind: 'tool', toolUseId: 't' },
        read: async () => result,
      }),
    ),
  )
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    'Check the current state before retrying',
  )
  const gap = host.querySelector('[data-testid="trace-gaps"]')
  expect(gap?.closest('[data-open]')?.getAttribute('data-open')).toBe('false')
  expect(gap?.textContent).toContain('uniquely')
  await act(async () => root.unmount())
})

describe('splitter', () => {
  it('clamps between 320px and 70% of the panel', () => {
    expect(clampInspectorWidth(100, 1200)).toBe(320)
    expect(clampInspectorWidth(1000, 1200)).toBe(840)
    expect(clampInspectorWidth(500, 1200)).toBe(500)
    expect(clampInspectorWidth(500, 300)).toBe(320)
  })

  it('remembers the width locally, steps with the arrow keys and resets on double-click', async () => {
    let width = 0
    function Host() {
      const state = useInspectorWidth()
      width = state.width
      return createElement(TraceSplitter, { width: state.width, onChange: state.set, onReset: state.reset })
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Host)))
    expect(width).toBe(TRACE_INSPECTOR_DEFAULT_WIDTH)
    const splitter = host.querySelector('[data-testid="trace-splitter"]') as HTMLElement
    expect(splitter.getAttribute('role')).toBe('separator')
    await act(async () =>
      splitter.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })),
    )
    expect(width).toBe(TRACE_INSPECTOR_DEFAULT_WIDTH + 16)
    expect(localStorage.getItem(TRACE_INSPECTOR_WIDTH_KEY)).toBe(String(TRACE_INSPECTOR_DEFAULT_WIDTH + 16))
    await act(async () => root.unmount())
    const again = createRoot(host)
    await act(async () => again.render(createElement(Host)))
    expect(width).toBe(TRACE_INSPECTOR_DEFAULT_WIDTH + 16)
    await act(async () =>
      host
        .querySelector('[data-testid="trace-splitter"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    )
    expect(width).toBe(TRACE_INSPECTOR_DEFAULT_WIDTH)
    expect(localStorage.getItem(TRACE_INSPECTOR_WIDTH_KEY)).toBeNull()
    await act(async () => again.unmount())
  })
})

describe('trace search marks', () => {
  const row: TraceRow = {
    id: 'row-1',
    seq: 1,
    title: '读取 pom.xml',
    text: '读取 pom.xml',
    kind: 'tool',
    badge: '工具',
    statusCode: 'completed',
    preview: '',
    raw: '',
    source: 'read',
    status: '已完成',
  }

  it('wraps every occurrence of the query in the row text', () => {
    const html = renderToStaticMarkup(createElement('span', null, highlight('读取 a，再读取 b', '读取')))
    expect(html.match(/<mark>/g)).toHaveLength(2)
  })

  it('flags a non-current hit on the row, so a match outside the visible text still shows', () => {
    const html = renderToStaticMarkup(
      createElement(TraceListRow, {
        row,
        showStep: false,
        selected: false,
        current: false,
        match: true,
        query: '读取',
        depth: 0,
        listItem: true,
        onSelect: () => undefined,
      }),
    )
    expect(html).toContain('data-match="hit"')
    expect(html).toContain('<mark>读取</mark>')
  })
})

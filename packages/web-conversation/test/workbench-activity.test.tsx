/** @vitest-environment happy-dom */
import type { FactChainParams, FactChainResult, UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { FactChainPanel } from '../src/workbench/fact-chain-panel.js'
import { activityTimeline } from '../src/workbench/fact-timeline.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'

const review = {
  model: 'reviewer',
  promptHash: 'a'.repeat(64),
  argsHash: 'b'.repeat(64),
  scopeHash: 'c'.repeat(64),
  decision: 'allow',
  risk: 'low',
  reason: 'workspace write',
  latencyMs: 12,
  cost: 0,
  costSource: 'unavailable',
  source: 'model',
} as const

const timeline = {
  sessionId: 's',
  upto: 50,
  generation: 1,
  opState: { kind: 'idle' },
  nodes: [
    { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '读一下 portal' }] },
    {
      kind: 'tool',
      id: 'n-read',
      seq: 3,
      toolUseId: 'use-read',
      name: 'read',
      status: 'completed',
      summary: 'portal.html',
    },
    { kind: 'user', id: 'u2', seq: 10, content: [{ type: 'text', text: '做一个鞋子门户网站' }] },
    {
      kind: 'tool',
      id: 'n-write',
      seq: 12,
      toolUseId: 'use-write',
      name: 'write',
      status: 'completed',
      summary: 'boot-portal.html',
      argsPreview: JSON.stringify({ path: 'boot-portal.html', content: '<html>' }),
      review,
    },
    {
      kind: 'tool',
      id: 'n-fetch',
      seq: 14,
      toolUseId: 'use-fetch',
      name: 'web_fetch',
      status: 'failed',
      summary: 'https://example.com',
    },
    {
      kind: 'tool',
      id: 'n-serve',
      seq: 16,
      toolUseId: 'use-serve',
      name: 'shell',
      status: 'completed',
      summary: 'npx serve .',
    },
    {
      kind: 'artifact',
      id: 'n-art',
      seq: 18,
      name: 'boot-portal.html',
      ref: { sha256: 'd'.repeat(64), size: 10, mime: 'text/html' },
    },
  ],
  turns: [
    {
      id: 't1',
      turn: 1,
      startSeq: 1,
      endSeq: 5,
      startedAt: '2026-10-14T09:00:00Z',
      status: 'completed',
      nodeIds: ['u1', 'n-read'],
      usage: { totals: {}, reasoningComplete: true, billingComplete: true, calls: [] },
      inherited: false,
      forkable: true,
    },
    {
      id: 't2',
      turn: 2,
      startSeq: 10,
      endSeq: 20,
      startedAt: '2026-10-14T09:01:00Z',
      status: 'completed',
      nodeIds: ['u2', 'n-write', 'n-fetch', 'n-serve', 'n-art'],
      usage: {
        totals: {},
        reasoningComplete: true,
        billingComplete: true,
        calls: [
          {
            id: 'effect-1',
            seq: 11,
            purpose: 'inference',
            model: 'demo-model',
            creditSource: 'estimated',
            tokens: { input: 2032, output: 994, cacheRead: 0, cacheWrite: 0 },
            timing: { durationMs: 4100 },
          },
        ],
      },
      inherited: false,
      forkable: true,
      trace: {
        id: 'root',
        kind: 'turn',
        name: 'turn',
        status: 'completed',
        startSeq: 10,
        startedAt: '2026-10-14T09:01:00Z',
        children: [
          {
            id: 'gen',
            kind: 'generation',
            name: 'demo-model',
            status: 'completed',
            startSeq: 11,
            startedAt: '2026-10-14T09:01:01Z',
            effectId: 'effect-1',
            requestTraceId: '11111111-1111-1111-1111-111111111111',
            children: [],
          },
          {
            id: 'tool',
            kind: 'tool',
            name: 'write',
            status: 'completed',
            startSeq: 12,
            startedAt: '2026-10-14T09:02:11Z',
            durationMs: 200,
            toolUseId: 'use-write',
            children: [],
          },
        ],
      },
    },
  ],
} as unknown as UITimeline

const chain = (nodes: unknown[]): FactChainResult =>
  ({ sessionId: 's', laneId: 'main', atSeq: 50, edges: [], gaps: [], nodes }) as unknown as FactChainResult

function mount(
  session: Session,
  extra: { factChain?: FactChainParams; openPanel?: (id: string, selection?: unknown) => void } = {},
  locale: 'en' | 'zh-CN' = 'zh-CN',
) {
  const host = document.createElement('div')
  document.body.append(host)
  const render = (factChain?: FactChainParams) =>
    renderRegion(
      host,
      <FactChainPanel
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, locale),
          ...(extra.openPanel ? { openPanel: extra.openPanel } : {}),
          data: { session, timeline, disabled: false, ...(factChain ? { factChain } : {}) },
        }}
      />,
    )
  render(extra.factChain)
  return { host, render }
}
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-testid=activity-row]')]

it('builds turns newest first, with requests, tool calls and artifacts in ledger order', () => {
  const turns = activityTimeline(timeline)
  expect(turns.map((turn) => turn.turn)).toEqual([2, 1])
  expect(turns[0]?.prompt).toBe('做一个鞋子门户网站')
  expect(turns[0]?.rows.map((row) => [row.kind, row.name, row.status?.key])).toEqual([
    ['request', 'demo-model', 'facts.ok'],
    ['tool', 'write', 'facts.ok'],
    ['tool', 'web_fetch', 'facts.errorResult'],
    ['tool', 'shell', 'facts.ok'],
    ['artifact', 'boot-portal.html', undefined],
  ])
  // The request links to its fact chain through the trace span that carries the request trace id.
  expect(turns[0]?.rows[0]?.anchor).toEqual({
    kind: 'request',
    callId: '11111111-1111-1111-1111-111111111111',
  })
  expect(turns[0]?.rows[1]?.durationMs).toBe(200)
  expect(activityTimeline(undefined)).toEqual([])
})

it('shows the timeline grouped by turn with status tags, and filters tool calls and failures', () => {
  const session = { id: 's', factChain: vi.fn(() => new Promise(() => {})) } as unknown as Session
  const { host } = mount(session)
  try {
    const heads = [...host.querySelectorAll('.workbench-activity-turn-head')].map((node) => node.textContent)
    expect(heads[0]).toMatch(/^第 2 轮 · .+ · 「做一个鞋子门户网站」$/)
    expect(heads[1]).toMatch(/^第 1 轮 · /)
    expect(host.querySelector('[data-testid=activity-summary]')?.textContent).toBe('6 条')
    const first = rows(host)[0] as HTMLElement
    expect(first.querySelector('strong')?.textContent).toBe('模型请求')
    expect(first.querySelector('small')?.textContent).toBe('demo-model · 输入 2,032 · 输出 994')
    expect(first.querySelector('.workbench-activity-meta')?.textContent).toBe('收到结果4.1s')
    const fetchRow = rows(host)[2] as HTMLElement
    expect(fetchRow.querySelector('strong')?.textContent).toBe('抓取网页')
    expect(fetchRow.querySelector('[data-testid=activity-status]')?.getAttribute('data-tone')).toBe('err')
    expect(fetchRow.querySelector('[data-testid=activity-status]')?.textContent).toBe('工具返回错误')
    flushSync(() => (host.querySelector('[data-testid=activity-filter-tools]') as HTMLInputElement).click())
    expect(rows(host).every((row) => row.dataset.kind === 'tool')).toBe(true)
    expect(host.querySelector('[data-testid=activity-summary]')?.textContent).toBe('4 条')
    flushSync(() => (host.querySelector('[data-testid=activity-filter-issues]') as HTMLInputElement).click())
    expect(rows(host).map((row) => row.querySelector('strong')?.textContent)).toEqual(['抓取网页'])
    expect(host.querySelector('.workbench-tab-footer')?.textContent).toBe(
      '只展示已有记录；没有回执的外部操作，是否完成为未知',
    )
  } finally {
    unmountRegion(host)
    host.remove()
  }
})

it('expands a row into its key facts, settles its tag from the receipt and keeps IDs folded', async () => {
  const factChain = vi.fn(async () =>
    chain([
      {
        id: 'inv',
        kind: 'invocation',
        toolUseId: 'use-write',
        name: 'write',
        callSeq: 41,
        invocationId: null,
        effectId: null,
        definitionFingerprint: null,
        policyHash: null,
        parentEffectId: null,
        review,
      },
      {
        id: 'rec',
        kind: 'receipt',
        toolUseId: 'use-write',
        resultSeq: 42,
        settledSeq: 43,
        isError: false,
        code: null,
        outcome: 'unknown',
        resultKind: 'deferred-accepted',
        partial: false,
        externalOutcome: 'unknown',
      },
    ]),
  )
  const openPanel = vi.fn()
  const session = { id: 's', factChain } as unknown as Session
  const { host } = mount(session, { openPanel })
  try {
    const write = rows(host)[1] as HTMLElement
    flushSync(() => write.click())
    expect(write.getAttribute('aria-expanded')).toBe('true')
    expect(factChain).toHaveBeenCalledWith({ kind: 'tool', toolUseId: 'use-write' }, 'main', {
      timeoutMs: 10_000,
    })
    await vi.waitFor(() =>
      expect(host.querySelector('.workbench-activity-facts')?.textContent).toContain('结果'),
    )
    const facts = host.querySelector('.workbench-activity-facts')?.textContent ?? ''
    expect(facts).toContain('授权审查模型自动放行: workspace write')
    expect(facts).toContain('已接收后台任务，完成情况未知')
    expect(write.querySelector('[data-testid=activity-status]')?.textContent).toBe('已接收后台任务')
    expect(write.querySelector('[data-testid=activity-status]')?.getAttribute('data-tone')).toBe('warn')
    // The future-call rule buttons stay with the review that suggested them.
    expect(host.querySelector('[data-testid=review-future-allow]')).not.toBeNull()
    expect(host.querySelector('[data-testid=review-future-deny]')).not.toBeNull()
    const technical = host.querySelector('.workbench-activity-technical') as HTMLElement
    expect(technical.dataset.open).toBe('false')
    expect(technical.textContent).toContain('use-write')
    flushSync(() => (host.querySelector('[data-testid=activity-affects]') as HTMLButtonElement).click())
    expect(openPanel).toHaveBeenCalledWith('changed-files', { sessionId: 's', path: 'boot-portal.html' })
    // The settled tag counts as an unknown outcome under 失败与未知.
    flushSync(() => (host.querySelector('[data-testid=activity-filter-issues]') as HTMLInputElement).click())
    expect(rows(host).map((row) => row.querySelector('strong')?.textContent)).toEqual([
      '写入文件',
      '抓取网页',
    ])
  } finally {
    unmountRegion(host)
    host.remove()
  }
})

it('selects the row a link names, and opens a record the timeline does not list on its own', async () => {
  const factChain = vi.fn(async () => chain([]))
  const session = { id: 's', factChain } as unknown as Session
  const { host, render } = mount(session, {
    factChain: { sessionId: 's', laneId: 'main', anchor: { kind: 'tool', toolUseId: 'use-serve' } },
  })
  try {
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-expanded=true] strong')?.textContent).toBe('运行命令'),
    )
    expect(factChain).toHaveBeenCalledWith({ kind: 'tool', toolUseId: 'use-serve' }, 'main', {
      timeoutMs: 10_000,
    })
    expect(host.querySelector('[data-testid=activity-pinned]')).toBeNull()
    render({ sessionId: 's', laneId: 'main', anchor: { kind: 'tool', toolUseId: 'older-call' } })
    await vi.waitFor(() => expect(host.querySelector('[data-testid=activity-pinned]')).not.toBeNull())
    expect(factChain).toHaveBeenLastCalledWith({ kind: 'tool', toolUseId: 'older-call' }, 'main', {
      timeoutMs: 10_000,
    })
    // A link for another session is ignored.
    render({ sessionId: 'other', laneId: 'main', anchor: { kind: 'tool', toolUseId: 'use-read' } })
    expect(host.querySelector('[aria-expanded=true]')).toBeNull()
  } finally {
    unmountRegion(host)
    host.remove()
  }
})

it('says so when a session has no activity yet', () => {
  const host = document.createElement('div')
  document.body.append(host)
  try {
    renderRegion(
      host,
      <FactChainPanel
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
          data: { session: { id: 's' }, timeline: { ...timeline, turns: [] }, disabled: false },
        }}
      />,
    )
    expect(host.textContent).toContain('No activity in this session yet.')
    expect(host.querySelector('[data-testid=activity-summary]')?.textContent).toBe('0 records')
  } finally {
    unmountRegion(host)
    host.remove()
  }
})

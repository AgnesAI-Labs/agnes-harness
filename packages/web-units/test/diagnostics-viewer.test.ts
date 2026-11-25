/** @vitest-environment happy-dom */

import type { UISpan, UITimeline, UITurn } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { DiagnosticsBundle } from '../src/diagnostics-types.js'
import { escapeBundleJson, renderDiagnosticsViewer } from '../src/diagnostics-viewer.js'
import { durationLabel, traceStats } from '../src/trace-model.js'

function makeBundle(overrides: Partial<DiagnosticsBundle> = {}): DiagnosticsBundle {
  return {
    bundleVersion: 1,
    createdAt: '2026-09-24T01:02:03.000Z',
    product: 'agh',
    version: '0.0.0-test',
    sessionId: 'sess-1',
    sessionTitle: 'a normal title',
    include: { conversation: true, logs: true, system: true },
    artifacts: [],
    warnings: [],
    ...overrides,
  }
}

const turnUsage = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}

function twoLevelTimeline(): UITimeline {
  const child: UISpan = {
    id: 'span-child',
    kind: 'tool',
    name: 'child-tool',
    status: 'completed',
    startSeq: 1,
    startedAt: '2026-09-24T01:00:00.100Z',
    durationMs: 250,
    children: [],
  }
  const root: UISpan = {
    id: 'span-root',
    kind: 'generation',
    name: 'root-call',
    status: 'completed',
    startSeq: 1,
    startedAt: '2026-09-24T01:00:00.000Z',
    durationMs: 1500,
    model: 'test-model',
    children: [child],
  }
  const turn: UITurn = {
    id: 'turn-1',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-09-24T01:00:00.000Z',
    status: 'completed',
    nodeIds: [],
    usage: turnUsage,
    inherited: false,
    forkable: true,
    trace: root,
  }
  return {
    sessionId: 'sess-1',
    upto: 1,
    generation: 1,
    opState: null,
    nodes: [],
    turns: [turn],
  }
}

describe('escapeBundleJson', () => {
  it('escapes script breakers', () => {
    const bundle = makeBundle({
      sessionTitle: '</script><img src=x onerror=alert(1)>',
      trace: {
        sessionId: 'sess-1',
        upto: 1,
        generation: 1,
        opState: null,
        nodes: [
          {
            kind: 'context',
            id: 'n1',
            seq: 1,
            text: 'line one\u2028line two\u2029end',
          },
        ],
        turns: [],
      },
    })
    const escaped = escapeBundleJson(bundle)
    expect(escaped).not.toContain('</script')
    expect(escaped).not.toContain('\u2028')
    expect(escaped).not.toContain('\u2029')
    expect(JSON.parse(escaped)).toEqual(bundle)
  })
})

describe('renderDiagnosticsViewer', () => {
  it('renders inert text', () => {
    const bundle = makeBundle({ sessionTitle: '</script><img src=x onerror=alert(1)>' })
    const html = renderDiagnosticsViewer(bundle)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('img')).toBeNull()
    const titleEl = doc.getElementById('agh-session-title')
    expect(titleEl?.textContent).toContain('</script>')
    const dataEl = doc.getElementById('agh-bundle')
    expect(dataEl?.getAttribute('type')).toBe('application/json')
    expect(dataEl?.textContent ? JSON.parse(dataEl.textContent) : null).toEqual(bundle)
  })

  it('executes the viewer script', () => {
    const bundle = makeBundle({
      trace: twoLevelTimeline(),
      logs: {
        daemon: { size: 10, text: 'request audit', missing: false, truncated: false },
        runtime: { size: 20, text: 'worker runtime output', missing: false, truncated: true },
      },
    })
    const html = renderDiagnosticsViewer(bundle)
    document.documentElement.innerHTML = html
    const scripts = Array.from(document.querySelectorAll('script'))
    const runtime = scripts.find((s) => s.getAttribute('type') !== 'application/json')
    expect(runtime).toBeDefined()
    new Function(runtime?.textContent ?? '')()

    const tabLabels = Array.from(document.querySelectorAll('#agh-tabs button')).map((b) => b.textContent)
    expect(tabLabels).toEqual(['Overview', 'Conversation', 'Trace', 'Logs', 'System', 'Artifacts'])

    expect(document.getElementById('tab-logs')?.textContent).toContain('worker runtime output')
    expect(document.getElementById('tab-logs')?.textContent).toContain('request audit')
    expect(document.getElementById('tab-logs')?.textContent).toContain('Daemon request audit')
    expect(document.getElementById('tab-logs')?.textContent).toContain('Daemon runtime')

    const traceText = document.getElementById('tab-trace')?.textContent ?? ''
    expect(traceText).toContain('root-call')
    expect(traceText).toContain('child-tool')
    expect(traceText).toMatch(/1\.5 s|1500 ms/)
    expect(traceText).toContain('250 ms')

    const traceTab = document.querySelector<HTMLButtonElement>('[data-tab="trace"]')
    traceTab?.click()
    expect(document.getElementById('tab-trace')?.hidden).toBe(false)
    expect(document.getElementById('tab-overview')?.hidden).toBe(true)
    traceTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const logsTab = document.querySelector<HTMLButtonElement>('[data-tab="logs"]')
    expect(document.activeElement).toBe(logsTab)
    expect(logsTab?.getAttribute('aria-selected')).toBe('true')
    expect(traceTab?.tabIndex).toBe(-1)
    expect(document.getElementById('tab-logs')?.hidden).toBe(false)
    expect(document.querySelector('script[src], link[rel="stylesheet"]')).toBeNull()
  })

  it('shows localized child notices and keeps full UUIDs in the collapsed raw record', () => {
    const id = '6b9f51a4-aef5-4733-a4f3-9592acc7d26a'
    const trace = twoLevelTimeline()
    trace.nodes = [
      {
        kind: 'user',
        id: 'child-notice',
        seq: 2,
        content: [{ type: 'text', text: `Child ${id} cancelled. [Batch State: completed=2/6]` }],
        system: {
          source: 'agnes/child',
          type: 'child-completed',
          summary: `Cancelled ${id}`,
          data: { childKey: id },
          presentation: { kind: 'child-completed', status: 'cancelled', label: 'Audit' },
        },
      },
      {
        kind: 'context',
        id: 'internal',
        seq: 3,
        text: `Reference ${id} [Batch State: completed=2/6] Finish correctly`,
      },
    ]
    const doc = new DOMParser().parseFromString(
      renderDiagnosticsViewer(makeBundle({ trace }), 'zh-CN'),
      'text/html',
    )
    const preview = [...doc.querySelectorAll('.agh-node-body')].map((node) => node.textContent).join(' ')
    expect(preview).toContain('Audit')
    expect(preview).toContain('取消')
    expect(preview).toContain('…c7d26a')
    expect(preview).not.toMatch(/Batch State|6b9f51a4/)
    const raw = doc.querySelector('#agh-raw-child-notice')
    expect(raw?.hasAttribute('hidden')).toBe(true)
    expect(raw?.textContent).toContain(id)
  })

  it('lists artifacts metadata', () => {
    const bundle = makeBundle({
      artifacts: [
        {
          sha256: 'abcdef0123456789abcdef0123456789',
          mime: 'image/png',
          lane: 'main',
          seq: 3,
          source: 'tool-result',
        },
      ],
    })
    const html = renderDiagnosticsViewer(bundle)
    document.documentElement.innerHTML = html
    const scripts = Array.from(document.querySelectorAll('script'))
    const runtime = scripts.find((s) => s.getAttribute('type') !== 'application/json')
    new Function(runtime?.textContent ?? '')()

    const artifactsText = document.getElementById('tab-artifacts')?.textContent ?? ''
    expect(artifactsText).toContain('abcdef012345')
    expect(artifactsText).not.toContain('abcdef0123456789abcdef0123456789')
    expect(artifactsText).toContain('image/png')
  })

  it('distinguishes unknown duration from running, carries minute boundaries and reports exported-but-empty tabs accurately', () => {
    const trace = twoLevelTimeline()
    trace.turns[0]!.trace = {
      id: 'root',
      kind: 'generation',
      name: 'root',
      status: 'completed',
      startSeq: 1,
      startedAt: '2026-09-24T01:00:00.000Z',
      children: [
        {
          id: 'c1',
          kind: 'tool',
          name: 'check',
          status: 'completed',
          startSeq: 2,
          startedAt: '2026-09-24T01:00:00.000Z',
          children: [],
        },
        {
          id: 'c2',
          kind: 'tool',
          name: 'wait',
          status: 'completed',
          startSeq: 3,
          startedAt: '2026-09-24T01:00:00.000Z',
          durationMs: 119_900,
          children: [],
        },
        {
          id: 'c3',
          kind: 'tool',
          name: 'edge',
          status: 'completed',
          startSeq: 4,
          startedAt: '2026-09-24T01:00:00.000Z',
          durationMs: 59_999,
          children: [],
        },
        {
          id: 'c4',
          kind: 'tool',
          name: 'live',
          status: 'running',
          startSeq: 5,
          startedAt: '2026-09-24T01:00:00.000Z',
          children: [],
        },
      ],
    }
    const doc = new DOMParser().parseFromString(
      renderDiagnosticsViewer(
        makeBundle({ include: { conversation: true, logs: false, system: true }, trace, artifacts: [] }),
        'zh-CN',
      ),
      'text/html',
    )
    const traceText = doc.getElementById('tab-trace')?.textContent ?? ''
    expect(traceText).toContain('tool · check · 已完成 · 时长未知')
    expect(traceText).not.toContain('已完成 · 进行中')
    expect(traceText).toContain('tool · wait · 已完成 · 2 分 0 秒')
    expect(traceText).not.toContain('1 分 60 秒')
    expect(traceText).toContain('tool · edge · 已完成 · 1 分 0 秒')
    expect(traceText).toContain('tool · live · 进行中 · 进行中')
    expect(doc.getElementById('tab-conversation')?.textContent).toContain('已导出，本次没有记录')
    expect(doc.getElementById('tab-artifacts')?.textContent).toContain('本次导出没有产物记录')
    expect(doc.getElementById('tab-logs')?.textContent).toContain('未选择导出')
    expect(doc.getElementById('tab-system')?.textContent).toContain('已选择导出，但内容不可用或未包含')

    // Online trace helpers share the same carry and missing-duration semantics.
    expect(durationLabel(119_900)).toBe('2 min 0 s')
    expect(durationLabel(59_999)).toBe('1 min 0 s')
    expect(durationLabel(undefined, 'completed')).toBe('Duration unknown')
    expect(durationLabel(0, 'completed')).toBe('0 ms')
    const unknownStats = traceStats([trace.turns[0]!])
    expect(unknownStats[0]?.[1]).toBe('Duration unknown')
    const partialStats = traceStats([
      trace.turns[0]!,
      { ...trace.turns[0]!, id: 'turn-2', turn: 2, durationMs: 1200 },
    ])
    expect(partialStats[0]?.[1]).toBe('1.2 s (partial)')
  })
})

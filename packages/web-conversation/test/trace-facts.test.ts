// @vitest-environment happy-dom

import type { FactChainResult, ToolReviewFact, UINode, UISpan, UITurn } from '@agnes/protocol'
import { workbenchPanels } from '@agnes/web-client'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  TRACE_PANEL_STORAGE_KEY,
  Trace,
  type TraceHandle,
  type TracePanelOptions,
} from '../src/trace-panel.js'
import '../src/workbench/register.js'

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  while (roots.length) roots.pop()?.unmount()
  document.body.replaceChildren()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

const at = '2026-10-14T08:57:28.000Z'
const callId = '00000000-0000-4000-8000-000000000001'
const review: ToolReviewFact = {
  model: 'guard',
  promptHash: 'a'.repeat(64),
  argsHash: 'b'.repeat(64),
  scopeHash: 'c'.repeat(64),
  decision: 'allow',
  risk: 'low',
  reason: 'workspace write',
  latencyMs: 12,
  cost: 0,
  costSource: 'estimated',
  source: 'model',
}
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
const nodes: UINode[] = [
  { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '写一个门户' }] },
  { kind: 'assistant', id: 'a1', seq: 3, text: '好的' },
  {
    kind: 'tool',
    id: 't1',
    seq: 4,
    resultSeq: 6,
    toolUseId: 'use-1',
    name: 'write',
    status: 'completed',
    summary: 'write',
    argsPreview: '{"path":"portal.html","content":"<html></html>"}',
    children: [],
  },
]
const turns: UITurn[] = [
  {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    startedAt: at,
    durationMs: 50,
    status: 'completed',
    nodeIds: ['u1', 'a1', 't1'],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
    trace: span({
      id: 'turn',
      kind: 'turn',
      children: [
        span({ id: 'g', kind: 'generation', model: 'demo', nodeIds: ['a1'], requestTraceId: callId }),
        span({ id: 'w', kind: 'tool', name: 'write', toolUseId: 'use-1', nodeIds: ['t1'], review }),
      ],
    }),
  },
]
const toolChain: FactChainResult = {
  sessionId: 's',
  laneId: 'main',
  atSeq: 9,
  edges: [],
  gaps: [{ at: null, reason: 'not-retained' }],
  nodes: [
    {
      id: 'i',
      kind: 'invocation',
      toolUseId: 'use-1',
      name: 'write',
      callSeq: 4,
      invocationId: null,
      effectId: null,
      definitionFingerprint: null,
      policyHash: null,
      parentEffectId: null,
    },
    {
      id: 'r',
      kind: 'receipt',
      toolUseId: 'use-1',
      resultSeq: 6,
      settledSeq: 6,
      isError: false,
      code: null,
      outcome: 'ok',
      resultKind: 'actual',
      partial: false,
      externalOutcome: 'unknown',
    },
    {
      id: 'ui-action',
      kind: 'plugin-fact',
      seq: 7,
      namespace: 'agnes/intelligent-ui',
      event: 'action.succeeded',
      label: 'Review report',
      state: 'succeeded',
      surfaceId: 'review',
      revision: 1,
    },
    {
      id: 'art',
      kind: 'artifact',
      seq: 5,
      relation: 'produced',
      ref: { sha256: 'd'.repeat(64), mime: 'text/html', size: 13 },
    },
  ],
} as unknown as FactChainResult

function mount(extra: Partial<TracePanelOptions> = {}, open = false) {
  if (open) sessionStorage.setItem(TRACE_PANEL_STORAGE_KEY, 'open')
  const root = document.createElement('aside')
  const toggle = document.createElement('button')
  const chat = document.createElement('button')
  const conversation = document.createElement('div')
  document.body.append(root, toggle, chat, conversation)
  const readFactChain = vi.fn(
    async (params: Parameters<NonNullable<TracePanelOptions['readFactChain']>>[0]) =>
      params.anchor.kind === 'authoring'
        ? ({
            ...toolChain,
            nodes: [{ id: 'au', kind: 'authoring', toolUseId: 'use-1', turn: 1 }],
          } as unknown as FactChainResult)
        : toolChain,
  )
  const handle = { current: null as TraceHandle | null }
  const reactRoot = createRoot(root)
  flushSync(() =>
    reactRoot.render(
      createElement(Trace, {
        ref: handle,
        root,
        options: { toggle, chatToggle: chat, conversation, store: sessionStorage, readFactChain, ...extra },
      }),
    ),
  )
  roots.push(reactRoot)
  const panel = handle.current as TraceHandle
  panel.render(nodes, turns, { hasEarlier: false, sessionId: 's' })
  return { root, panel, readFactChain, conversation }
}
const selected = (root: HTMLElement) =>
  root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')
const pane = (root: HTMLElement) => root.querySelector('.trace-inspector-pane')

it('opens the trace on the linked request with its source tab, never a workbench tab', async () => {
  const { root, panel, readFactChain } = mount()
  expect(panel.focusFact?.({ sessionId: 's', laneId: 'main', anchor: { kind: 'request', callId } })).toBe(
    true,
  )
  expect(panel.isOpen()).toBe(true)
  expect(selected(root)).toBe('a1')
  expect(pane(root)?.getAttribute('data-pane')).toBe('source')
  const tabs = root.querySelectorAll('.trace-inspector-tabs [role="tab"]')
  expect(tabs.length).toBeGreaterThan(1)
  for (const tab of tabs) expect(tab.hasAttribute('aria-pressed')).toBe(false)
  expect(root.querySelector('.trace-tab[aria-selected="true"]')?.getAttribute('data-pane')).toBe('source')
  await vi.waitFor(() =>
    expect(readFactChain).toHaveBeenCalledWith(
      { sessionId: 's', laneId: 'main', anchor: { kind: 'request', callId } },
      expect.any(AbortSignal),
    ),
  )
  // A link for another session is not this trace's to answer.
  expect(panel.focusFact?.({ sessionId: 'other', laneId: 'main', anchor: { kind: 'request', callId } })).toBe(
    false,
  )
  expect(workbenchPanels.get('facts')).toBeUndefined()
  expect(workbenchPanels.get('changed-files')).toBeDefined()
  flushSync(() => root.querySelector<HTMLButtonElement>('.trace-inspector-close')?.click())
  expect(root.querySelector('.trace-inspector')?.hasAttribute('hidden')).toBe(true)
  expect(document.activeElement).toBe(root.querySelector('.trace-row[data-trace-row-id="a1"]'))
})

it('reveals a filtered or folded tool and shows its authorization with future-call rules and receipt', async () => {
  const { root, panel } = mount({}, true)
  flushSync(() => root.querySelector<HTMLButtonElement>('.trace-turn-toggle')?.click())
  flushSync(() => root.querySelector<HTMLButtonElement>('.trace-chip[data-kind="assistant"]')?.click())
  expect(
    panel.focusFact?.({ sessionId: 's', laneId: 'main', anchor: { kind: 'tool', toolUseId: 'use-1' } }),
  ).toBe(true)
  expect(selected(root)).toBe('t1')
  expect(root.querySelector('.trace-chip[data-kind="all"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(root.querySelector('.trace-turn-toggle')?.getAttribute('aria-expanded')).toBe('true')
  expect(pane(root)?.querySelector('[data-testid="reviewer-decision"]')?.textContent).toContain(
    'workspace write',
  )
  await vi.waitFor(() =>
    expect(pane(root)?.querySelector('[data-link="receipt"]')?.textContent).toContain('Completed'),
  )
  expect(pane(root)?.querySelector('[data-link="ui"]')?.textContent).toContain('Action succeeded')
  expect(pane(root)?.querySelector('[data-link="ui"]')?.textContent).toContain('Review report · revision 1')
  expect(pane(root)?.querySelector('[data-testid="trace-gaps"]')?.textContent).toContain('not retained')
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response('{}')
      : new Response(JSON.stringify({ enabled: true, overrides: [] })),
  )
  vi.stubGlobal('fetch', fetch)
  flushSync(() => root.querySelector<HTMLButtonElement>('[data-testid="review-future-ask"]')?.click())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  const saved = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as { overrides: unknown[] }
  expect(saved.overrides).toEqual([
    { tool: 'write', scopeHash: review.scopeHash, decision: 'escalate', risk: 'low' },
  ])
})

it('opens the record that produced an artifact and downloads it from the source tab', async () => {
  const release = vi.fn()
  const loadArtifact = vi.fn(async () => ({ url: 'blob:x', release }))
  const { root, panel } = mount({ loadArtifact })
  expect(
    panel.focusFact?.({
      sessionId: 's',
      laneId: 'main',
      anchor: {
        kind: 'artifact',
        seq: 5,
        ref: { sha256: 'd'.repeat(64), mime: 'text/html', size: 13 },
      } as never,
    }),
  ).toBe(true)
  expect(selected(root)).toBe('t1')
  await vi.waitFor(() => expect(root.querySelector('[data-testid="artifact-download"]')).not.toBeNull())
  flushSync(() => root.querySelector<HTMLButtonElement>('[data-testid="artifact-download"]')?.click())
  await vi.waitFor(() =>
    expect(loadArtifact).toHaveBeenCalledWith({
      laneId: 'main',
      artifact: expect.objectContaining({ mime: 'text/html' }),
    }),
  )
})

it.each(['tool', 'feedback'])(
  'follows a %s candidate to its source and published version',
  async (origin) => {
    const { root, panel } = mount({
      readFactChain: async () =>
        ({
          ...toolChain,
          nodes: [
            {
              id: 'au',
              kind: 'authoring',
              toolUseId: origin === 'tool' ? 'use-1' : 'feedback:source',
              turn: 1,
              candidateId: `candidate-${'e'.repeat(32)}`,
              packageId: 'reviewed-evidence',
              version: '1.0.0',
              state: 'published',
              candidateHash: 'hash',
              reviewHash: 'review',
              baseHash: null,
              testHash: 'hash',
              testsState: 'passed',
              testsCount: 1,
              reviewed: true,
            },
          ],
        }) as unknown as FactChainResult,
    })
    const candidateId = `candidate-${'e'.repeat(32)}`
    expect(
      panel.focusFact?.({ sessionId: 's', laneId: 'main', anchor: { kind: 'authoring', candidateId } }),
    ).toBe(true)
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            growth:
              origin === 'feedback'
                ? [
                    {
                      feedbackId: 'source',
                      feedbackRevision: 1,
                      messageSeq: 3,
                      candidateId,
                      candidateHash: 'hash',
                      reviewHash: 'review',
                      state: 'published',
                      reviewer: 'local',
                      packageId: 'feedback-skill-evidence',
                      version: '1.0.0',
                    },
                  ]
                : [],
            counts: { up: 0, down: 1, withdrawn: 0, withCandidate: 1 },
            truncated: false,
          }),
        ),
    )
    await vi.waitFor(() => expect(selected(root)).toBe(origin === 'tool' ? 't1' : 'a1'))
    expect(pane(root)?.getAttribute('data-pane')).toBe('source')
    await vi.waitFor(() =>
      expect(pane(root)?.querySelector('[data-testid="trace-authoring"]')?.textContent).toContain(
        'reviewed-evidence 1.0.0 · Published',
      ),
    )
    expect(pane(root)?.querySelector('[data-testid="trace-authoring"]')?.textContent).toContain(
      'Tests passed: 1',
    )
    expect(pane(root)?.querySelector('[data-testid="trace-authoring"]')?.textContent).toContain(
      'Human review recorded',
    )
    expect(
      pane(root)?.querySelector('[data-testid="trace-authoring"] .agh-disclosure')?.getAttribute('data-open'),
    ).toBe('false')
    if (origin === 'feedback')
      await vi.waitFor(() =>
        expect(pane(root)?.querySelector('[data-testid="feedback-provenance"]')?.textContent).toContain(
          'Published version: feedback-skill-evidence@1.0.0',
        ),
      )
    else expect(pane(root)?.querySelector('[data-testid="feedback-provenance"]')).toBeNull()
  },
)

it('opens the turn from the usage popover on its source tab', () => {
  const { root, conversation } = mount()
  turns[0] &&
    conversation.dispatchEvent(new CustomEvent('agnes:trace-turn', { detail: { turnId: 'turn:1' } }))
  expect(selected(root)).toBe('a1')
  expect(pane(root)?.getAttribute('data-pane')).toBe('source')
})

it('pages back to a fact whose record lies before the loaded window, then opens it', async () => {
  const { root, panel } = mount({}, true)
  // Only the latest record is loaded; the tool call that produced the fact is earlier.
  const loadEarlier = vi.fn(() => panel.render(nodes, turns, { hasEarlier: false, sessionId: 's' }))
  panel.render(nodes.slice(0, 1), [{ ...turns[0]!, nodeIds: ['u1'] }], {
    hasEarlier: true,
    loadEarlier,
    sessionId: 's',
  })
  expect(
    panel.focusFact?.({ sessionId: 's', laneId: 'main', anchor: { kind: 'tool', toolUseId: 'use-1' } }),
  ).toBe(true)
  await vi.waitFor(() => expect(selected(root)).toBe('t1'))
  expect(loadEarlier).toHaveBeenCalledTimes(1)
  expect(pane(root)?.getAttribute('data-pane')).toBe('source')
})

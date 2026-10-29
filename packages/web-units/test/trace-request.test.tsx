/** @vitest-environment happy-dom */
import type { ModelRequestParams, ModelRequestResult, ModelRequestSnapshot } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import {
  RequestCapture,
  RequestContent,
  type RequestTraceState,
  RequestUsage,
  requestBaseline,
  stepCalls,
  useRequestTrace,
} from '../src/trace-request.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const snapshot: ModelRequestSnapshot = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-10-08T00:00:00Z',
  system: 'new persona\nsafety',
  systemHash: 'a'.repeat(64),
  toolsHash: 'b'.repeat(64),
  sectionsHash: 'c'.repeat(64),
  derivedHash: 'd'.repeat(64),
  sections: [{ id: 'persona', source: 'profile:system-prompt', order: 1, text: 'new persona' }],
  tools: [{ name: 'read' }],
  messages: [{ role: 'user' }],
  params: { model: 'demo' },
  response: { tokens: { input: 10 } },
  wire: null,
  messagesHash: 'a'.repeat(64),
  sourceHashes: [],
  generationId: null,
  promptHash: 'a'.repeat(64),
  toolSchemaHash: 'b'.repeat(64),
  memoryRevision: null,
  memoryHash: null,
  compactionBoundary: null,
  hashBasis: 'redacted-json',
  incomplete: false,
  wireUnavailable: 'adapter-no-tap',
  tokens: { providerActual: null, estimated: null },
  attempts: [],
  capture: 'logical-request',
  redacted: false,
}
const ids = {
  first: snapshot.id,
  second: '00000000-0000-4000-8000-000000000002',
  compaction: '00000000-0000-4000-8000-000000000003',
}

function Harness(props: {
  sessionId: string
  callId: string
  read: Parameters<typeof useRequestTrace>[0]['read']
  clear?: (input: unknown) => Promise<{ cleared: boolean }>
  locale?: 'en' | 'zh-CN'
  expose(state: RequestTraceState): void
}) {
  const state = useRequestTrace(props)
  props.expose(state)
  return createElement(
    'div',
    null,
    createElement(RequestContent, { state }),
    createElement(RequestUsage, { state }),
    createElement(RequestCapture, { state, ...(props.clear ? { clear: props.clear as never } : {}) }),
  )
}

it('keeps only the calls of this step in the call picker', () => {
  const call = (id: string, kind: string) => ({ id, kind, createdAt: '', model: 'demo' })
  const calls = [call('a', 'inference'), call('c', 'compaction'), call('b', 'inference')]
  expect(stepCalls(calls, 'b').map((item) => item.id)).toEqual(['c', 'b'])
  expect(stepCalls(calls, 'a').map((item) => item.id)).toEqual(['a'])
  expect(stepCalls(calls, 'missing')).toEqual([])
})

it('shows the request in folded sections, the sent JSON on demand, comparisons, attempts, tokens and the local delete', async () => {
  const calls: ModelRequestParams[] = []
  const deleted: unknown[] = []
  const clear = async (input: unknown) => {
    deleted.push(input)
    return { cleared: true }
  }
  const read = async (params: ModelRequestParams): Promise<ModelRequestResult> => {
    calls.push(params)
    if (!params.callId)
      return {
        snapshot: null,
        previous: null,
        calls: [
          { id: ids.second, createdAt: snapshot.createdAt, kind: 'inference', model: 'demo' },
          { id: ids.compaction, createdAt: snapshot.createdAt, kind: 'compaction', model: 'demo' },
          { id: ids.first, createdAt: snapshot.createdAt, kind: 'inference', model: 'demo' },
        ],
      }
    return {
      snapshot: params.callId.endsWith('3')
        ? {
            ...snapshot,
            system: 'compacted history',
            capture: 'final-provider-body',
            wire: { attempt: 1 },
            wireUnavailable: null,
            tokens: { providerActual: { input: 99 }, estimated: null },
            attempts: [0, 1].map((index) => ({
              attemptId: `00000000-0000-4000-8000-00000000000${index + 4}`,
              parentCallId: snapshot.id,
              index,
              adapter: { id: 'test', version: '1', api: 'test', endpoint: null },
              status: index === 0 ? ('failed' as const) : ('completed' as const),
              wire: index === 0 ? null : { attempt: index },
              wireUnavailable: index === 0 ? ('not-sent' as const) : null,
              promptHash: null,
              toolSchemaHash: null,
              providerActualTokens: index === 0 ? null : { input: 99 },
              estimatedTokens: null,
              response: {},
            })),
          }
        : snapshot,
      previous: { ...snapshot, system: 'old persona\nsafety' },
    }
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let state: RequestTraceState | undefined
  const expose = (value: RequestTraceState) => {
    state = value
  }
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)
  const content = () => q('request-trace-content')?.textContent ?? ''
  try {
    await act(async () =>
      root.render(createElement(Harness, { sessionId: 'old', callId: ids.first, read, expose })),
    )
    // Four folded sections with their sizes; the system prompt opens with its sources named.
    for (const section of ['system', 'tools', 'messages', 'params'])
      expect(q(`request-trace-section-${section}`)).not.toBeNull()
    expect(q('request-trace-section-system')?.textContent).toContain('1 sections')
    expect(q('request-trace-section-tools')?.textContent).toContain('1 tools')
    const toolsToggle = () => q('request-trace-section-tools-toggle') as HTMLButtonElement
    expect(toolsToggle().getAttribute('aria-expanded')).toBe('false')
    await act(async () => toolsToggle().click())
    expect(toolsToggle().getAttribute('aria-expanded')).toBe('true')
    await act(async () =>
      root.render(createElement(Harness, { sessionId: 'old', callId: ids.first, read, expose })),
    )
    expect(toolsToggle().getAttribute('aria-expanded')).toBe('true')
    await act(async () => toolsToggle().click())
    expect(toolsToggle().getAttribute('aria-expanded')).toBe('false')
    expect(q('request-trace-source')?.textContent).toContain('Your custom persona')
    expect(q('request-trace-source')?.getAttribute('title')).toContain('profile:system-prompt')
    expect(q('request-trace-summary')?.textContent).toContain('demo')
    // The picker lists this step's calls only: the compaction before it and the request itself.
    const picker = q('request-trace-call') as HTMLSelectElement
    expect([...picker.options].map((option) => option.value)).toEqual([ids.compaction, ids.first])
    // The sent JSON is a view switch; unavailable capture says why and cannot be copied.
    await act(async () => host.querySelector<HTMLInputElement>('input[value="wire"]')!.click())
    expect(content()).toContain('Final provider body unavailable')
    expect(content()).not.toContain('new persona')
    expect((q('request-trace-copy') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => host.querySelector<HTMLInputElement>('input[value="logical"]')!.click())
    await act(async () => state?.setCompare('previous'))
    expect(host.querySelector('del')?.textContent).toContain('old persona')
    expect(host.querySelector('ins')?.textContent).toContain('new persona')
    expect(q('request-trace-section-system')?.textContent).toContain('Changed')
    expect(q('request-trace-section-system-toggle')?.getAttribute('aria-expanded')).toBe('true')
    requestBaseline.pin({ sessionId: 'old', callId: ids.first })
    await act(async () =>
      root.render(createElement(Harness, { key: 'new', sessionId: 'new', callId: ids.second, read, expose })),
    )
    await act(async () => state?.setCompare('fixed'))
    expect(calls.findLast((call) => call.callId === ids.second)?.compare).toEqual({
      sessionId: 'old',
      callId: ids.first,
    })
    await act(async () => {
      const select = q('request-trace-call') as HTMLSelectElement | null
      if (select) {
        select.value = ids.compaction
        select.dispatchEvent(new Event('change', { bubbles: true }))
      } else state?.selectCall(ids.compaction)
    })
    expect(calls.findLast((call) => call.callId)?.callId).toBe(ids.compaction)
    expect(q('request-trace-summary')?.textContent).toContain('Attempt 2/2')
    await act(async () => {
      const select = q('request-trace-attempt') as HTMLSelectElement
      select.value = '0'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(q('request-trace-usage')?.textContent).toContain('Provider token usage is missing.')
    expect(q('request-trace-summary')?.textContent).toContain('Attempt 1/2')
    expect(q('request-trace-summary')?.textContent).toContain('Failed')
    expect(q('request-trace-summary')?.textContent).not.toContain('99')
    await act(async () => host.querySelector<HTMLInputElement>('input[value="wire"]')!.click())
    expect(content()).toContain('Not sent')
    expect(content()).not.toContain('does not support capture')
    requestBaseline.clear()
    await act(async () =>
      root.render(
        createElement(Harness, {
          key: 'zh',
          sessionId: 'old',
          callId: ids.first,
          read,
          clear,
          locale: 'zh-CN',
          expose,
        }),
      ),
    )
    expect(q('request-trace-section-system')?.textContent).toContain('系统提示词')
    expect(host.querySelector('input[value="wire"]')?.closest('label')?.textContent).toBe('实际发送 JSON')
    expect((q('request-trace-delete') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => (q('request-trace-delete-confirm') as HTMLInputElement).click())
    await act(async () => (q('request-trace-delete') as HTMLButtonElement).click())
    expect(deleted).toHaveLength(1)
    expect(host.textContent).toContain('此请求已不在保留范围内。')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

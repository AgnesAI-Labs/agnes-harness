/** @vitest-environment happy-dom */
import type { ModelRequestParams, ModelRequestResult, ModelRequestSnapshot } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { RequestTraceView } from '../src/trace-request.js'

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
it('shows captured sources and all request panes, highlights changes and explicitly selects an owner-checked comparison', async () => {
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
          { id: snapshot.id, createdAt: snapshot.createdAt, kind: 'inference', model: 'demo' },
          {
            id: '00000000-0000-4000-8000-000000000003',
            createdAt: snapshot.createdAt,
            kind: 'compaction',
            model: 'demo',
          },
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
  const compare = async (value: string) =>
    act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="request-trace-compare"]')!
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  try {
    await act(async () =>
      root.render(createElement(RequestTraceView, { sessionId: 'old', callId: snapshot.id, read })),
    )
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6)
    expect(host.querySelector('[data-testid="request-trace-source"]')?.textContent).toContain(
      'Your custom persona',
    )
    expect(host.querySelector('[data-testid="request-trace-source"]')?.getAttribute('title')).toContain(
      'profile:system-prompt',
    )
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).toContain('demo')
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain(
      'Logical request before adapter transforms',
    )
    expect(host.textContent).toContain('final provider body unavailable')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-raw"]')!.click(),
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain(
      'Final provider body unavailable',
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).not.toContain(
      'new persona',
    )
    expect(host.querySelector<HTMLButtonElement>('[data-testid="request-trace-copy"]')?.disabled).toBe(true)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-system"]')!.click(),
    )
    await compare('previous')
    expect(host.querySelector('del')?.textContent).toContain('old persona')
    expect(host.querySelector('ins')?.textContent).toContain('new persona')
    await compare('pin')
    await act(async () =>
      root.render(
        createElement(RequestTraceView, {
          key: 'new',
          sessionId: 'new',
          callId: '00000000-0000-4000-8000-000000000002',
          read,
        }),
      ),
    )
    await compare('fixed')
    expect(calls.findLast((call) => call.callId === '00000000-0000-4000-8000-000000000002')?.compare).toEqual(
      { sessionId: 'old', callId: snapshot.id },
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-tools"]')!.click(),
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain('read')
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="request-trace-call"]')!
      select.value = '00000000-0000-4000-8000-000000000003'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-system"]')!.click(),
    )
    expect(calls.findLast((call) => call.callId)?.callId).toBe('00000000-0000-4000-8000-000000000003')
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[data-testid="request-trace-attempt"]')!
      select.value = '0'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-tokens"]')!.click(),
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain(
      'Provider token usage is missing.',
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).not.toContain('99')
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).toContain('Attempt 1/2')
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).toContain('Failed')
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).not.toContain('99')
    await compare('previous')
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).toContain('Attempt 1/2')
    expect(host.querySelector('[data-testid="request-trace-summary"]')?.textContent).not.toContain('99')
    await compare('none')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-raw"]')!.click(),
    )
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain('Not sent')
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).not.toContain(
      'no capture tap',
    )
    expect(host.querySelector<HTMLButtonElement>('[data-testid="request-trace-copy"]')?.disabled).toBe(true)

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-tab-system"]')!.click(),
    )
    await compare('previous')
    expect(host.querySelector('[data-testid="request-trace-content"]')?.textContent).toContain(
      'compacted history',
    )
    await compare('clear')
    await act(async () =>
      root.render(
        createElement(RequestTraceView, {
          sessionId: 'old',
          callId: snapshot.id,
          read,
          clear,
          locale: 'zh-CN',
        }),
      ),
    )
    expect(
      [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.replace(/\s/g, '')),
    ).toEqual(['系统提示词', '工具', '消息', '参数', 'Token', '原始JSON'])
    expect(host.querySelector<HTMLButtonElement>('[data-testid="request-trace-delete"]')?.disabled).toBe(true)
    await act(async () =>
      host.querySelector<HTMLInputElement>('[data-testid="request-trace-delete-confirm"]')!.click(),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="request-trace-delete"]')!.click(),
    )
    expect(deleted).toHaveLength(1)
    expect(host.textContent).toContain('此请求已不在保留范围内。')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

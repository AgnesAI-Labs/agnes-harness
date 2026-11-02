import { canonicalJson } from '@agnes/core-common/request/hash'
import type { Event } from '@agnes/core-common/types'
import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/execution/model-tokens.js'
import { requestComposition } from '../src/execution/request-composition.js'
import { turnWaitSummary } from '../src/execution/turn-wait.js'
import type { RequestMessage } from '../src/request/mint.js'

describe('request composition diagnostics', () => {
  it.each(['secret-path-and-arguments', '私密内容混合ASCII', 'a"\\\n😀'])(
    'partitions serialized input without retaining %s',
    (secret) => {
      const wire: RequestBody = {
        kind: 'inference',
        sessionKey: 's',
        slot: 'primary',
        route: 'r',
        model: 'm',
        contractId: null,
        derivedHash: 'hash',
        system: secret,
        tools: [{ name: 'read', description: secret, parameters: {} }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: secret }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: secret },
              { type: 'thinking', text: secret },
            ],
            toolCalls: [
              { toolUseId: 'old', name: 'read', args: { path: secret }, ordinal: 0 },
              { toolUseId: 'new', name: 'read', args: {}, ordinal: 1 },
            ],
          },
          {
            role: 'tool_result',
            toolUseId: 'old',
            content: [{ type: 'text', text: secret }],
            isError: false,
          },
          {
            role: 'tool_result',
            toolUseId: 'new',
            content: [{ type: 'text', text: secret.repeat(4) }],
            isError: false,
          },
          { role: 'user', content: [{ type: 'text', text: secret }] },
          { role: 'user', content: [{ type: 'text', text: secret }] },
        ],
      }
      const messages: RequestMessage[] = [1, 2, 3, 8, 9, 0].map((seq) => ({ seq, role: 'user', content: [] }))
      const result = requestComposition(wire, messages, new Set([9]), 5)
      expect(result.total).toBe(
        estimateTokens(canonicalJson({ system: wire.system, messages: wire.messages, tools: wire.tools })),
      )
      expect(Object.values(result.tokens).reduce((a, b) => a + b, 0)).toBe(result.total)
      expect(Object.values(result.tokens).every((n) => n > 0)).toBe(true)
      expect(result.toolResultCount).toBe(2)
      expect(result.largestToolResult).toEqual({
        tool: 'read',
        bytes: new TextEncoder().encode(canonicalJson(wire.messages[3]?.content)).length,
      })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(requestComposition(wire, messages, new Set([9]), 10).tokens.toolResultsCurrentStep).toBe(0)
      expect(JSON.stringify(result).length).toBeLessThan(400)
      const empty = { ...wire, system: '', tools: [], messages: [] }
      const emptyResult = requestComposition(empty, [], new Set(), 0)
      expect(emptyResult.total).toBe(estimateTokens(canonicalJson({ system: '', tools: [], messages: [] })))
      expect(emptyResult.toolResultCount).toBe(0)
      expect(emptyResult.largestToolResult).toBeNull()
      wire.messages.push({ role: 'user', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] })
      const withImage = requestComposition(wire, messages, new Set([9]), 5)
      expect(withImage.total).toBe(
        estimateTokens(
          canonicalJson({
            system: wire.system,
            messages: wire.messages,
            tools: wire.tools,
          }),
        ),
      )
    },
  )

  it('sums model and tool durations once, preserving missing timings and failure attempts', () => {
    const row = (type: string, data: Event['data']) => ({ type, data })
    const rows = [
      row('effect/intent', { effectId: 'm', kind: 'inference' }),
      row('cost/ledger', { effectId: 'm', timing: { providerCallMs: 20, durationMs: 15 } }),
      row('effect/settled', { effectId: 'm', durationMs: 30 }),
      row('effect/intent', { effectId: 'retry', kind: 'inference' }),
      row('effect/settled', { effectId: 'retry', outcome: 'error', durationMs: 7 }),
      row('effect/intent', { effectId: 'a', kind: 'tool', tool: { name: 'read' } }),
      row('effect/settled', { effectId: 'a', durationMs: 8 }),
      row('effect/intent', { effectId: 'b', kind: 'tool', tool: { name: 'read' } }),
      row('effect/intent', { effectId: 'c', kind: 'tool', tool: { name: '__proto__' } }),
      row('effect/settled', { effectId: 'c', durationMs: 0 }),
    ]
    expect(turnWaitSummary(rows)).toEqual({
      model: { count: 2, ms: 27, missing: 0 },
      tools: [
        { tool: 'read', count: 2, ms: 8, missing: 1 },
        { tool: '__proto__', count: 1, ms: 0, missing: 0 },
      ],
    })
  })
})

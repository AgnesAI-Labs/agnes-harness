import type { LoopEventContext } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { LoopEventRegistry } from '../src/loop/events.js'

const context = { session: {}, signal: new AbortController().signal } as unknown as LoopEventContext
const payload = { result: { content: [{ type: 'text', text: 'ok' }] } } as never

describe('after_tool_result replacement budget', () => {
  it('hands the next handler a value already cut to the budget', async () => {
    const events = new LoopEventRegistry()
    const seen: number[] = []
    events.on('after_tool_result', () => ({
      result: { content: [{ type: 'text', text: '中'.repeat(50_000) }] },
    }))
    events.on('after_tool_result', (p) => {
      seen.push(p.result.content.reduce((n, b) => n + (b.type === 'text' ? Buffer.byteLength(b.text) : 0), 0))
      return {}
    })
    const out = await events.dispatch('after_tool_result', payload, context, 2048)
    expect(seen[0]).toBeLessThan(2048 + 256)
    expect(JSON.stringify(out).length).toBeLessThan(4096)
  })
})

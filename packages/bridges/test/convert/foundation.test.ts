import { validateEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  detectSource,
  EnvelopeBuilder,
  parseJsonl,
  pathToLatestLeaf,
  sanitizeToolName,
  Tolerance,
  textBlocks,
  ulidAt,
} from '../../src/convert/index.js'

const now = () => Date.parse('2026-09-07T00:00:00Z')
const rng = () => 0.5
const builder = () =>
  new EnvelopeBuilder({
    source: 'pi',
    sessionKey: 'agnes:local:default:import:dm:test',
    now,
    rng,
    agnesVersion: '0.0.0',
  })

describe('import foundations', () => {
  it('makes deterministic ULIDs and unique builder IDs at one source timestamp', () => {
    const first = ulidAt(now(), rng)
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ulidAt(now(), rng)).toBe(first)
    expect(ulidAt(now() + 1, rng) > first).toBe(true)

    const b = builder()
    b.start({ sourceId: 's', cwd: '/w' })
    b.user([{ type: 'text', text: 'hi' }], new Date(now()).toISOString())
    b.assistant([{ type: 'text', text: 'hello' }], 'end_turn', new Date(now()).toISOString())
    const events = b.finish()
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    for (const event of events) expect(validateEvent(event).ok, event.type).toBe(true)
  })

  it('synthesizes valid turn/step/tool relations and refuses stray or duplicate results', () => {
    const b = builder()
    b.start({ sourceId: 's', cwd: '/w' })
    b.user([{ type: 'text', text: 'hi' }])
    b.assistant([{ type: 'text', text: 'calling' }], 'tool_use')
    b.toolCall({ toolUseId: 't1', name: 'shell', args: { command: 'ls' } })
    expect(
      b.toolResult({
        toolUseId: 't1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    ).toBe(true)
    expect(b.toolResult({ toolUseId: 't1', content: [], isError: false })).toBe(false)
    expect(b.toolResult({ toolUseId: 'ghost', content: [], isError: false })).toBe(false)
    b.assistant([{ type: 'text', text: 'done' }], 'end_turn')
    expect(b.finish().map((event) => event.type)).toEqual([
      'session/start',
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })

  it('parses BOM/blank JSONL, records bad rows, and exposes safe mapping helpers', () => {
    const tolerance = new Tolerance()
    const rows = parseJsonl(new TextEncoder().encode('\uFEFF{"a":1}\n\nnot json\n{"b":2}\r\n'), tolerance)
    expect(rows).toEqual([
      { line: 1, value: { a: 1 } },
      { line: 4, value: { b: 2 } },
    ])
    expect(tolerance.finish('pi', rows.length).skipped).toEqual([{ line: 3, reason: 'invalid json' }])
    expect(sanitizeToolName('9/mcp-tool')).toBe('t_9_mcp_tool')
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(64)
    expect(textBlocks('')).toEqual([{ type: 'text', text: '' }])
  })

  it('detects all source headers without treating an unheaded body as a session', () => {
    expect(detectSource([{ type: 'session', id: 's' }])).toBe('pi')
    expect(detectSource([{ type: 'session_meta', payload: { id: 's' } }])).toBe('codex')
    expect(
      detectSource([
        { id: 'old', timestamp: '2020-01-01T00:00:00Z', instructions: 'x' },
        { record_type: 'state' },
        { type: 'message', role: 'user', content: [] },
      ]),
    ).toBe('codex')
    expect(detectSource([{ type: 'user', parentUuid: null, isSidechain: false }])).toBe('claude-code')
    expect(
      detectSource([{ seq: 1, type: 'session/start', actor: {}, origin: 'system', trust: 'trusted' }]),
    ).toBe('agnes')
    expect(detectSource([{ v: 'agnes-cli-result/v1' }])).toBe('cli-result')
    expect(detectSource([{ type: 'message', role: 'user' }])).toBe('unknown')
  })

  it('takes the newest leaf, counts branch roots, and repairs orphan/duplicate ids', () => {
    const tolerance = new Tolerance()
    const result = pathToLatestLeaf(
      [
        { id: 'a', parentId: null, ts: 1, node: 'a' },
        { id: 'b', parentId: 'a', ts: 2, node: 'b' },
        { id: 'c', parentId: 'a', ts: 3, node: 'c' },
        { id: 'd', parentId: 'c', ts: 4, node: 'd' },
        { id: 'e', parentId: 'missing', ts: 5, node: 'e' },
        { id: 'e', parentId: null, ts: 6, node: 'duplicate' },
      ],
      tolerance,
    )
    expect(result.path).toEqual(['a', 'c', 'd', 'e'])
    expect(result.repairedIds).toEqual(['e', 'e'])
    expect(tolerance.finish('pi', 0)).toMatchObject({
      branches: { kept: 1, dropped: 1 },
      repaired: [{ seq: 5 }, { seq: 6 }],
    })
  })
})

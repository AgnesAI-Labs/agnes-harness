import { readFileSync } from 'node:fs'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { exportClaudeCode, exportShareGpt, importSession, toTranscript } from '../../src/convert/index.js'

const fixture = readFileSync(new URL('../../fixtures/import/claude-code/basic.jsonl', import.meta.url))
const events = importSession(fixture, { now: () => 0, rng: () => 0.5 }).events

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ev = (seq: number, type: string, data: unknown): EventEnvelope =>
  ({
    seq,
    ts: new Date(seq * 1000).toISOString(),
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
    type,
    data,
    actor,
    origin: 'model',
    trust: 'trusted',
    lane: 'main',
  }) as never

describe('sharing exports', () => {
  it('projects messages, calls, results and summaries without chunk noise', () => {
    const transcript = toTranscript(events)
    expect(transcript.cwd).toBe('/w')
    expect(transcript.items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'summary',
    ])
    expect(transcript.items[1]).toMatchObject({
      kind: 'assistant',
      calls: [{ toolUseId: 'toolu_1', name: 'mcp_server_tool', args: { command: 'ls' } }],
    })
  })

  it('emits ShareGPT role and inline tool forms', () => {
    const role = JSON.parse(new TextDecoder().decode(exportShareGpt(events, { id: 'shared' })))
    expect(role.id).toBe('shared')
    expect(role.conversations.map((item: { from: string }) => item.from)).toEqual([
      'human',
      'gpt',
      'tool',
      'gpt',
      'system',
    ])
    const inline = JSON.parse(new TextDecoder().decode(exportShareGpt(events, { tools: 'inline' })))
    expect(inline.conversations.some((item: { from: string }) => item.from === 'tool')).toBe(false)
    expect(JSON.stringify(inline)).toContain('tool_result')
  })

  it('emits a valid Claude Code parent chain and summary leaf', () => {
    const rows = new TextDecoder()
      .decode(exportClaudeCode(events))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map((row) => row.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'summary'])
    expect(rows[0]?.parentUuid).toBeNull()
    expect(rows[1]?.parentUuid).toBe(rows[0]?.uuid)
    expect(rows.at(-1)).toMatchObject({ type: 'summary', leafUuid: rows.at(-2)?.uuid })
  })

  it('drops a runtime_context notice from the transcript and both exporters instead of faking a human turn', () => {
    const withNotice: EventEnvelope[] = [
      ev(1, 'session/start', { key: 'agnes:test', imported: { cwd: '/w' } }),
      ev(2, 'user/message', { content: [{ type: 'text', text: 'hi' }], kind: 'prompt' }),
      // A hook note or per-turn model/cwd/preset snapshot, tagged the same as core actually emits it.
      ev(3, 'user/message', {
        content: [{ type: 'text', text: '{"model":"x","cwd":"/w"}' }],
        kind: 'runtime_context',
      }),
      ev(4, 'assistant/message', { content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' }),
    ]

    expect(toTranscript(withNotice).items.map((item) => item.kind)).toEqual(['user', 'assistant'])

    const gpt = JSON.parse(new TextDecoder().decode(exportShareGpt(withNotice))) as {
      conversations: Array<{ from: string; value: string }>
    }
    expect(gpt.conversations.map((item) => item.from)).toEqual(['human', 'gpt'])
    expect(JSON.stringify(gpt)).not.toContain('runtime_context')

    const rows = new TextDecoder()
      .decode(exportClaudeCode(withNotice))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map((row) => row.type)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(rows)).not.toContain('runtime_context')
  })
})

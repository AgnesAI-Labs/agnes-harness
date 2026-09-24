import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkRelations } from '../src/log/relations.js'
import { initialState } from '../src/reduce/reducer.js'
import type { Event } from '../src/types.js'

const events = readFileSync(new URL('../fixtures/reduce/long-session.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Event)

describe('fold performance (core 稿 §19 第 2 问，待验证假设)', () => {
  it('keeps the fixture at exactly 10,000 events', () => {
    expect(events).toHaveLength(10_000)
    for (const event of events) {
      if (event.type !== 'turn/end') continue
      const lastAssistantSeq = (event.data as { lastAssistantSeq: number }).lastAssistantSeq
      expect(events[lastAssistantSeq - 1]?.type).toBe('assistant/message')
    }
    expect(() => checkRelations(events, initialState())).not.toThrow()
  })
})

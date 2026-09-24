import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { SessionProjectUIParams, UINode, UITimeline } from '../gen/ts/agnes-v1.js'

const nodes = [
  { kind: 'user', id: 'u', seq: 1, content: [{ type: 'text', text: 'hi' }] },
  { kind: 'assistant', id: 'a', seq: 2, text: 'answer', thinking: 'thought', streaming: false },
  {
    kind: 'tool',
    id: 't',
    seq: 3,
    toolUseId: 'call',
    name: 'read',
    status: 'completed',
    summary: 'read a',
    enforcement: { level: 'full', scope: ['file'] },
    children: ['t2'],
    slots: [{ slot: 'tool.card.inline', extId: 'test/ext', payload: { title: 'card' } }],
  },
  {
    kind: 'approval',
    id: 'p',
    seq: 4,
    state: 'pending',
    summary: 'write',
    risk: 'destructive',
    options: ['allow_once', 'reject_once'],
    ticket: 'ticket',
    expiresAt: '2026-09-10T00:00:00Z',
    requestSeq: 4,
  },
  { kind: 'cost', id: 'c', seq: 5, source: 'estimated' },
  {
    kind: 'artifact',
    id: 'f',
    seq: 6,
    name: 'result',
    ref: { sha256: 'a'.repeat(64), size: 0, mime: 'text/plain' },
  },
  {
    kind: 'compaction',
    id: 'm',
    seq: 7,
    range: [1, 6],
    summary: 'summary',
    customInstructions: 'keep facts',
  },
  { kind: 'slot', id: 's', fill: { slot: 'notification', extId: 'test/ext', payload: { message: 'done' } } },
  {
    kind: 'context-sections',
    id: 'x',
    seq: 8,
    sections: [{ id: 'core:untrusted-envelope', order: 0, source: 'core', tokens: 378 }],
  },
  { kind: 'contribute-conflict', id: 'y', seq: 9, key: 'tools:sdk', ops: ['code-mode', 'skills'] },
]

describe('UI projection leaf contract', () => {
  it.each(nodes)('accepts $kind with its real nested imported schema', (node) => {
    expect(Value.Check(UINode, node)).toBe(true)
    expect(
      Value.Check(UITimeline, {
        sessionId: 's',
        upto: 7,
        generation: 2,
        opState: null,
        nodes: [node],
        turns: [],
      }),
    ).toBe(true)
  })
  it('accepts measured compaction and explicit zero cost while preserving absent data', () => {
    expect(Value.Check(UINode, { ...nodes[6], tokensBefore: 100, tokensAfter: 20 })).toBe(true)
    expect(Value.Check(UINode, { ...nodes[4], credits: 0 })).toBe(true)
  })
  it('rejects invalid nested data, old cards and extra generation omissions', () => {
    expect(Value.Check(UINode, { ...nodes[0], content: [{ type: 'text', text: 1 }] })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[5], ref: { sha256: 'bad', size: -1, mime: 'text/plain' } })).toBe(
      false,
    )
    expect(Value.Check(UINode, { ...nodes[2], status: 'done' })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[2], kind: 'tool_card' })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[2], summary: 'x'.repeat(513) })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[2], argsPreview: 'x'.repeat(2049) })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[2], resultPreview: 'x'.repeat(4097) })).toBe(false)
    expect(Value.Check(UINode, { ...nodes[3], risk: 'safe' })).toBe(false)
    expect(Value.Check(UITimeline, { sessionId: 's', upto: 0, opState: null, nodes: [] })).toBe(false)
  })
  it('accepts the default request and validates budget plus parked status', () => {
    expect(Value.Check(SessionProjectUIParams, { sessionId: 's' })).toBe(true)
    expect(
      Value.Check(UITimeline, {
        sessionId: 's',
        upto: 7,
        generation: 1,
        opState: { turn: 1, step: 2, phase: 'parked', parked: { ticket: 't', expiresAt: 'date' } },
        nodes,
        turns: [],
        budget: { slot: 'primary', escalate: false, creditsUsed: 2, creditsCap: null },
      }),
    ).toBe(true)
    expect(
      Value.Check(UITimeline, {
        sessionId: 's',
        upto: 7,
        generation: 1,
        opState: null,
        nodes: [],
        turns: [],
        budget: { creditsUsed: -1 },
      }),
    ).toBe(false)
  })
})

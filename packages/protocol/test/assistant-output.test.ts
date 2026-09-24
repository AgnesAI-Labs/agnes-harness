import { describe, expect, it } from 'vitest'
import * as AgnesGen from '../gen/ts/agnes-v1.js'
import { EVENT_TYPES, METHODS, validateAgainst, validateEvent, validateMethod } from '../src/index.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const row = (data: unknown) => ({
  seq: 1,
  ts: '2026-09-24T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type: 'assistant/output',
  data,
  actor,
  origin: 'model',
  trust: 'trusted',
})
const counts = { effectId: 'e1', chars: { text: 12, thinking: 0 }, estimatedTokens: 3 }

describe('assistant/output: the ledger record of streamed model output', () => {
  it('is a closed-set event type', () => {
    expect(EVENT_TYPES).toContain('assistant/output')
  })

  it('carries counts only while the stream is live', () => {
    for (const state of ['started', 'progress']) {
      const r = validateEvent(row({ state, ...counts }))
      expect(r.ok, `${state}: ${r.ok ? '' : JSON.stringify(r.errors)}`).toBe(true)
    }
    // Text on a live row is exactly what this type exists to keep off the ledger.
    expect(
      validateEvent(row({ state: 'progress', ...counts, content: [{ type: 'text', text: 'x' }] })).ok,
    ).toBe(false)
    expect(validateEvent(row({ state: 'started', ...counts, delta: 'x' })).ok).toBe(false)
  })

  it('carries the text said so far only when the stream was interrupted', () => {
    const interrupted = {
      state: 'interrupted',
      ...counts,
      content: [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'partial answer' },
      ],
    }
    const ok = validateEvent(row(interrupted))
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.errors)).toBe(true)
    expect(validateEvent(row({ state: 'interrupted', ...counts })).ok).toBe(false)
    expect(validateEvent(row({ ...interrupted, content: [{ type: 'image', text: 'x' }] })).ok).toBe(false)
  })

  it('refuses malformed counts and unknown states', () => {
    expect(validateEvent(row({ state: 'done', ...counts })).ok).toBe(false)
    expect(validateEvent(row({ state: 'started', ...counts, estimatedTokens: -1 })).ok).toBe(false)
    expect(validateEvent(row({ state: 'started', ...counts, chars: { text: 1.5, thinking: 0 } })).ok).toBe(
      false,
    )
    expect(validateEvent(row({ state: 'started', ...counts, chars: { text: 1 } })).ok).toBe(false)
    expect(validateEvent(row({ state: 'started', ...counts, effectId: 'e'.repeat(129) })).ok).toBe(false)
    const { effectId: _dropped, ...noEffect } = counts
    expect(validateEvent(row({ state: 'started', ...noEffect })).ok).toBe(false)
  })
})

describe('session.preview: streamed text that is never a ledger row', () => {
  const preview = {
    sessionId: 's1',
    lane: 'main',
    effectId: 'e1',
    stream: 'text',
    offset: 0,
    delta: 'hello',
  }

  it('is a server-to-client notification', () => {
    expect(METHODS['_agnes/v1/session.preview']).toMatchObject({ kind: 'notification', direction: 's2c' })
  })

  it('validates its params', () => {
    const ok = validateMethod('_agnes/v1/session.preview', 'params', preview)
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.errors)).toBe(true)
    expect(validateMethod('_agnes/v1/session.preview', 'params', { ...preview, stream: 'thinking' }).ok).toBe(
      true,
    )
    for (const bad of [
      { ...preview, offset: -1 },
      { ...preview, stream: 'audio' },
      { ...preview, lane: '' },
      { ...preview, sessionId: 's'.repeat(513) },
      { ...preview, seq: 3 },
    ])
      expect(validateMethod('_agnes/v1/session.preview', 'params', bad).ok, JSON.stringify(bad)).toBe(false)
    const { delta: _dropped, ...noDelta } = preview
    expect(validateMethod('_agnes/v1/session.preview', 'params', noDelta).ok).toBe(false)
  })

  it('is requested through the attach filter', () => {
    expect(validateAgainst(AgnesGen.AttachFilter, { preview: true }).ok).toBe(true)
    expect(validateAgainst(AgnesGen.AttachFilter, { preview: 'yes' }).ok).toBe(false)
  })
})

describe('UI assistant node: what a preview is joined to and what a crash lost', () => {
  const node = { kind: 'assistant', id: 'n1', seq: 4, text: '', streaming: true, effectId: 'e1' }

  it('names its effect and the characters a crash lost', () => {
    const ok = validateAgainst(AgnesGen.UINode, node)
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.errors)).toBe(true)
    expect(validateAgainst(AgnesGen.UINode, { ...node, streaming: false, lostChars: 120 }).ok).toBe(true)
    expect(validateAgainst(AgnesGen.UINode, { ...node, lostChars: -1 }).ok).toBe(false)
    expect(validateAgainst(AgnesGen.UINode, { ...node, effectId: 'e'.repeat(129) }).ok).toBe(false)
  })
})

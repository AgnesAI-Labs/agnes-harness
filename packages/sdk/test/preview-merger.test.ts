import type { UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { PREVIEW_MAX_CHARS, type Preview, PreviewMerger } from '../src/preview-merger.js'

const p = (delta: string, offset: number, o: Partial<Preview> = {}): Preview => ({
  lane: 'main',
  effectId: 'e1',
  stream: 'text',
  offset,
  delta,
  ...o,
})

const node = (o: Partial<Extract<UINode, { kind: 'assistant' }>> = {}): UINode => ({
  kind: 'assistant',
  id: 'n1',
  seq: 4,
  text: '',
  streaming: true,
  effectId: 'e1',
  ...o,
})

describe('PreviewMerger', () => {
  it('drops duplicates, trims overlap and keeps text and thinking apart', () => {
    const m = new PreviewMerger()
    expect(m.add(p('hel', 0))).toBe(true)
    expect(m.add(p('hel', 0))).toBe(false)
    expect(m.add(p('ello', 1))).toBe(true)
    expect(m.add(p('hm', 0, { stream: 'thinking' }))).toBe(true)
    expect(m.text('e1')).toEqual({ text: 'hello', thinking: 'hm', capped: false })
  })

  it('holds a piece that arrives ahead of a gap until the gap is filled', () => {
    const m = new PreviewMerger()
    expect(m.add(p('world', 6))).toBe(false)
    expect(m.text('e1')?.text).toBe('')
    expect(m.add(p('hello ', 0))).toBe(true)
    expect(m.text('e1')?.text).toBe('hello world')
  })

  it('accepts a snapshot that arrives after the deltas it covers', () => {
    const m = new PreviewMerger()
    m.add(p('abc', 0))
    m.add(p('def', 3))
    expect(m.add(p('abcdef', 0))).toBe(false)
    expect(m.add(p('abcdefgh', 0))).toBe(true)
    expect(m.text('e1')?.text).toBe('abcdefgh')
  })

  it('keeps two inferences apart', () => {
    const m = new PreviewMerger()
    m.add(p('one', 0))
    m.add(p('two', 0, { effectId: 'e2' }))
    expect(m.text('e1')?.text).toBe('one')
    expect(m.text('e2')?.text).toBe('two')
  })

  it('lays the text over every authoritative install, which leaves streaming nodes empty', () => {
    const m = new PreviewMerger()
    m.add(p('so far', 0))
    const timeline = { nodes: [node(), node({ id: 'n0', effectId: 'e0', streaming: false, text: 'old' })] }
    const applied = m.apply(timeline)
    expect(applied.nodes[0]).toMatchObject({ text: 'so far', streaming: true })
    expect(applied.nodes[1]).toBe(timeline.nodes[1])
    // A later install of the same still-streaming node gets the text back.
    expect(m.apply({ nodes: [node()] }).nodes[0]).toMatchObject({ text: 'so far' })
  })

  it('waits for a node that has not arrived yet', () => {
    const m = new PreviewMerger()
    m.add(p('early', 0))
    expect(m.apply({ nodes: [] }).nodes).toEqual([])
    expect(m.apply({ nodes: [node()] }).nodes[0]).toMatchObject({ text: 'early' })
  })

  it('forgets an inference once its node is final, and ignores previews that come later', () => {
    const m = new PreviewMerger()
    m.add(p('draft', 0))
    const final = node({ streaming: false, text: 'final answer' })
    expect(m.apply({ nodes: [final] }).nodes[0]).toBe(final)
    expect(m.text('e1')).toBeUndefined()
    expect(m.add(p('draft and more', 0))).toBe(false)
    expect(m.text('e1')).toBeUndefined()
  })

  it('stops accumulating past its limit and says so', () => {
    const m = new PreviewMerger()
    m.add(p('x'.repeat(PREVIEW_MAX_CHARS), 0))
    expect(m.add(p('y', PREVIEW_MAX_CHARS))).toBe(true)
    expect(m.text('e1')).toMatchObject({ capped: true })
    expect(m.text('e1')?.text.length).toBe(PREVIEW_MAX_CHARS)
    expect(m.add(p('z', PREVIEW_MAX_CHARS))).toBe(false)
  })

  it('starts over on reset', () => {
    const m = new PreviewMerger()
    m.add(p('stale', 0))
    m.reset()
    expect(m.text('e1')).toBeUndefined()
    expect(m.add(p('new', 0))).toBe(true)
  })
})

describe('Session.onPreview', () => {
  it('hands over well-formed previews only, and stops when unsubscribed', async () => {
    const { Session } = await import('../src/session.js')
    const session = new Session({} as never, 's')
    const seen: unknown[] = []
    const off = session.onPreview((x) => seen.push(x))
    const good = { sessionId: 's', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi' }
    session.onNotification('_agnes/v1/session.preview', good)
    session.onNotification('_agnes/v1/session.preview', { ...good, offset: -1 })
    session.onNotification('session/update', { sessionId: 's', update: {} })
    off()
    session.onNotification('_agnes/v1/session.preview', good)
    expect(seen).toEqual([good])
  })
})

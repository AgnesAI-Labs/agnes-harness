/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { SessionPreviewParams, UINode, UITimeline, UITurn } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createLiveProjection } from '../src/live-projection.js'
import { mountTranscriptRegion } from '../src/region-slots.js'

const usage: UITurn['usage'] = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}
const turn = (
  id: string,
  nodeIds: string[],
  status: UITurn['status'],
  finalAssistantId?: string,
): UITurn => ({
  id,
  turn: Number(id.slice(-1)),
  startSeq: Number(id.slice(-1)) === 1 ? 1 : 4,
  startedAt: '2026-09-25T00:00:00.000Z',
  status,
  nodeIds,
  ...(finalAssistantId ? { finalAssistantId } : {}),
  usage,
  inherited: false,
  forkable: false,
})
const user = (id: string, seq: number, text: string): UINode => ({
  kind: 'user',
  id,
  seq,
  content: [{ type: 'text', text }],
})
const assistant = (id: string, seq: number, effectId: string, text: string, streaming: boolean): UINode => ({
  kind: 'assistant',
  id,
  seq,
  effectId,
  text,
  streaming,
})

it('keeps one recovered answer and projects a later request through live projection and the real region', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.setSession('s')
  const transcript = document.createElement('section')
  transcript.id = 'transcript'
  document.body.append(transcript)
  const mounted = mountTranscriptRegion(registry, transcript, { nodeHost: 'react' })
  const state: UITimeline = {
    sessionId: 's',
    generation: 1,
    upto: 2,
    opState: null,
    nodes: [user('u1', 1, 'first request'), assistant('a1', 2, 'e1', '', true)],
    turns: [turn('t1', ['u1', 'a1'], 'running')],
  }
  const previewListeners = new Set<(value: SessionPreviewParams) => void>()
  const handlers = new Map<string, Set<() => void>>()
  let pendingNext: ((value: IteratorResult<never>) => void) | undefined
  const connection = {
    connectionState: 'connected',
    on(event: string, handler: () => void) {
      const listeners = handlers.get(event) ?? new Set<() => void>()
      listeners.add(handler)
      handlers.set(event, listeners)
      return () => listeners.delete(handler)
    },
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler()
    },
  }
  const session = {
    projectUIOpening: vi.fn(async () => ({
      timeline: structuredClone(state),
      history: { hasEarlier: false, startIndex: 0, totalNodes: state.nodes.length },
    })),
    projectUIPatch: vi.fn(async (from: number) => ({
      kind: 'patch',
      patch: {
        sessionId: 's',
        generation: 1,
        from,
        upto: state.upto,
        totalNodes: state.nodes.length,
        opState: null,
        changes: state.nodes.map((node, index) => ({ op: 'upsert', index, node: structuredClone(node) })),
        turnChanges: state.turns.map((value, index) => ({
          op: 'upsert',
          index,
          turn: structuredClone(value),
        })),
      },
    })),
    projectUIHistory: vi.fn(),
    events: vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<never>>((resolve) => {
            pendingNext = resolve
          }),
        return: async () => {
          pendingNext?.({ done: true, value: undefined })
          pendingNext = undefined
          return { done: true as const, value: undefined }
        },
      }),
    })),
    onPreview(listener: (value: SessionPreviewParams) => void) {
      previewListeners.add(listener)
      return () => previewListeners.delete(listener)
    },
  }
  const errors: unknown[] = []
  const seen: Array<{ text: string; status: UITurn['status'] | undefined }> = []
  const live = createLiveProjection(session as never, connection as never, {
    timeline(value) {
      const answer = value.nodes.find((node) => node.id === 'a1')
      seen.push({ text: answer?.kind === 'assistant' ? answer.text : '', status: value.turns[0]?.status })
      mounted.render(value.nodes, value.turns)
    },
    stream(value) {
      mounted.render(value.nodes, value.turns)
    },
    event() {},
    error(error) {
      errors.push(error)
    },
  })
  try {
    await act(async () => live.start())
    const placeholder = transcript.querySelector<HTMLElement>('[data-node-id="a1"]')
    expect(placeholder?.hidden).toBe(true)
    expect(transcript.querySelector<HTMLElement>('.turn-status')?.hidden).toBe(false)
    await act(async () => {
      for (const listener of previewListeners)
        listener({
          sessionId: 's',
          lane: 'main',
          effectId: 'e1',
          stream: 'text',
          offset: 0,
          delta: 'partial',
        })
    })
    const firstArticle = transcript.querySelector<HTMLElement>('[data-node-id="a1"]')
    expect(firstArticle).toBe(placeholder)
    expect(firstArticle?.textContent).toContain('partial')
    const selection = document.getSelection()
    const retainedParagraph = firstArticle?.querySelector('.node-body p')
    const retainedRange = document.createRange()
    retainedRange.selectNodeContents(retainedParagraph?.firstChild ?? transcript)
    selection?.removeAllRanges()
    selection?.addRange(retainedRange)
    connection.connectionState = 'reconnecting'
    connection.emit('reconnecting')
    connection.connectionState = 'connected'
    connection.emit('reconnected')
    await vi.waitFor(() => expect(session.projectUIOpening).toHaveBeenCalledTimes(2))
    expect(firstArticle?.hidden).toBe(false)
    expect(transcript.querySelector('[data-node-id="a1"]')).toBe(firstArticle)
    expect(firstArticle?.textContent).toContain('partial')
    expect(firstArticle?.querySelector('.node-body p')).toBe(retainedParagraph)
    expect(selection?.toString()).toBe('partial')
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await act(async () => {
      for (const listener of previewListeners)
        listener({
          sessionId: 's',
          lane: 'main',
          effectId: 'e1',
          stream: 'text',
          offset: 0,
          delta: 'restarted output',
        })
    })
    expect(transcript.querySelector('[data-node-id="a1"]')).toBe(firstArticle)
    expect(firstArticle?.hidden).toBe(false)
    expect(firstArticle?.textContent).toContain('restarted output')
    expect(firstArticle?.textContent).not.toContain('partial')
    const paragraph = firstArticle?.querySelector('.node-body p')
    const range = document.createRange()
    range.selectNodeContents(paragraph?.firstChild ?? transcript)
    selection?.removeAllRanges()
    selection?.addRange(range)
    await act(async () => {
      for (const listener of previewListeners)
        listener({
          sessionId: 's',
          lane: 'main',
          effectId: 'e1',
          stream: 'text',
          offset: 'restarted output'.length,
          delta: ' done',
        })
    })
    expect(firstArticle?.querySelector('.node-body p')).toBe(paragraph)
    expect(selection?.toString()).toBe('restarted output')
    state.upto = 3
    state.nodes[1] = assistant('a1', 2, 'e1', 'restarted output done', false)
    state.turns[0] = turn('t1', ['u1', 'a1'], 'completed', 'a1')
    await act(async () => live.refresh())
    await vi.waitFor(() =>
      expect(transcript.querySelector('[data-turn-id="t1"]')?.getAttribute('data-status')).toBe('completed'),
    )
    expect(seen.at(-1)).toEqual({ text: 'restarted output done', status: 'completed' })
    expect(transcript.querySelector('[data-node-id="a1"]')).toBe(firstArticle)
    expect(selection?.toString()).toBe('restarted output')
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    await vi.waitFor(() => expect(firstArticle?.textContent).toContain('restarted output done'))
    state.upto = 5
    state.nodes.push(user('u2', 4, 'second request'), assistant('a2', 5, 'e2', '', true))
    state.turns.push(turn('t2', ['u2', 'a2'], 'running'))
    await act(async () => live.refresh())
    await vi.waitFor(() => expect(transcript.querySelector('[data-node-id="a2"]')).toBeTruthy())
    await act(async () => {
      for (const listener of previewListeners)
        listener({
          sessionId: 's',
          lane: 'main',
          effectId: 'e2',
          stream: 'text',
          offset: 0,
          delta: 'second partial',
        })
    })
    const secondArticle = transcript.querySelector('[data-node-id="a2"]')
    expect(secondArticle?.textContent).toContain('second partial')
    connection.connectionState = 'reconnecting'
    connection.emit('reconnecting')
    connection.connectionState = 'connected'
    connection.emit('reconnected')
    await vi.waitFor(() => expect(session.projectUIOpening).toHaveBeenCalledTimes(3))
    expect(transcript.querySelector('[data-node-id="a2"]')).toBe(secondArticle)
    expect(secondArticle?.textContent).toContain('second partial')
    state.upto = 6
    state.nodes[3] = assistant('a2', 5, 'e2', 'second answer', false)
    state.turns[1] = turn('t2', ['u2', 'a2'], 'completed', 'a2')
    await act(async () => live.refresh())
    await vi.waitFor(() => expect(secondArticle?.textContent).toContain('second answer'))
    expect(
      [...transcript.querySelectorAll('[data-node-id]')].map((node) => node.getAttribute('data-node-id')),
    ).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(transcript.querySelectorAll('[data-node-id="a1"]')).toHaveLength(1)
    const patchCount = session.projectUIPatch.mock.calls.length
    await act(async () => live.refresh())
    await vi.waitFor(() => expect(session.projectUIPatch.mock.calls.length).toBeGreaterThan(patchCount))
    expect(transcript.querySelector('[data-node-id="a1"]')).toBe(firstArticle)
    expect(transcript.querySelector('[data-node-id="a2"]')).toBe(secondArticle)
    expect(transcript.querySelectorAll('[data-node-id]')).toHaveLength(4)
    expect(errors).toEqual([])
  } finally {
    await live.stop()
    mounted.dispose()
    await ctx.fiber.dispose()
    transcript.remove()
  }
})

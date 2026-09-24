import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { PreviewDelta } from '../src/step/preview.js'
import { sentFor, usage } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

/** Streams the given deltas, pausing before `pauseAt` until `release` is called. */
function gatedProvider(deltas: InferenceEvent[], pauseAt: number) {
  let release!: () => void
  const gate = new Promise<void>((res) => {
    release = res
  })
  let reached!: () => void
  const paused = new Promise<void>((res) => {
    reached = res
  })
  const provider: Provider = {
    models: () => [],
    async *infer(req): AsyncIterable<InferenceEvent> {
      yield sentFor(req)
      for (const [i, d] of deltas.entries()) {
        if (i === pauseAt) {
          reached()
          await gate
        }
        yield d
      }
      yield usage()
      yield { type: 'done', reason: 'stop' }
    },
  }
  return { provider, release, paused }
}

const joined = (seen: PreviewDelta[], stream: 'text' | 'thinking') => {
  let out = ''
  for (const p of seen.filter((x) => x.stream === stream)) {
    expect(p.offset).toBe(out.length)
    out += p.delta
  }
  return out
}

describe('streamed text is published live', () => {
  it('publishes each stream with contiguous offsets that add up to the final message', async () => {
    const { provider, release } = gatedProvider(
      [
        { type: 'thinking_delta', delta: 'let me ' },
        { type: 'thinking_delta', delta: 'think' },
        { type: 'text_delta', delta: 'hello ' },
        { type: 'text_delta', delta: 'world' },
      ],
      99,
    )
    release()
    const { session, log } = await openSession({ provider })
    const seen: PreviewDelta[] = []
    session.onPreview((p) => seen.push(p))
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(joined(seen, 'thinking')).toBe('let me think')
    expect(joined(seen, 'text')).toBe('hello world')
    expect(new Set(seen.map((p) => p.lane))).toEqual(new Set(['main']))
    const effectIds = new Set(seen.map((p) => p.effectId))
    expect(effectIds.size).toBe(1)
    const intent = (await log.scan({ type: 'effect/intent', limit: 10 })).find(
      (row) => (row.data as { kind?: string }).kind === 'inference',
    )
    expect([...effectIds][0]).toBe((intent?.data as { effectId?: string } | undefined)?.effectId)
  })

  it('answers a snapshot with the text so far while the inference runs, and nothing after', async () => {
    const { provider, release, paused } = gatedProvider(
      [
        { type: 'text_delta', delta: 'partial ' },
        { type: 'text_delta', delta: 'answer' },
        { type: 'text_delta', delta: ' done' },
      ],
      2,
    )
    const { session } = await openSession({ provider })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await paused
    const mid = session.previewSnapshot()
    expect(mid).toHaveLength(1)
    expect(mid[0]).toMatchObject({ lane: 'main', text: 'partial answer', thinking: '' })
    release()
    expect((await run).reason).toBe('completed')
    expect(session.previewSnapshot()).toEqual([])
  })

  it('keeps streaming when a preview listener throws', async () => {
    const { provider, release } = gatedProvider([{ type: 'text_delta', delta: 'fine' }], 99)
    release()
    const { session, log } = await openSession({ provider })
    session.onPreview(() => {
      throw new Error('viewer broke')
    })
    const seen: PreviewDelta[] = []
    session.onPreview((p) => seen.push(p))
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(joined(seen, 'text')).toBe('fine')
    expect(await log.scan({ type: 'assistant/message', limit: 5 })).toHaveLength(1)
  })

  it('stops delivering to a listener that unsubscribed', async () => {
    const { provider, release } = gatedProvider([{ type: 'text_delta', delta: 'x' }], 99)
    release()
    const { session } = await openSession({ provider })
    const seen: PreviewDelta[] = []
    const off = session.onPreview((p) => seen.push(p))
    off()
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(seen).toEqual([])
  })
})

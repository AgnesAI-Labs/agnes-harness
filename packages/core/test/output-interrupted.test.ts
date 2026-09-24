import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, sent, sentFor, textTurn, usage } from './helpers/fake-provider.js'
import { actor, immediateTimers, openSession } from './helpers/open-session.js'

/**
 * Streamed text no longer lives on the ledger as it arrives. What a stopped answer had already said
 * must still be recorded once, as an `assistant/output` row in state `interrupted`, whenever the
 * process is alive to write it: a user stop, a provider error, and a session close all qualify.
 */

const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

/** Streams two text deltas, then hangs until the request's own signal is aborted. */
const streamThenHang = (): Provider => ({
  models: () => [],
  async *infer(req, o): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    yield { type: 'text_delta', delta: 'partial ' }
    yield { type: 'text_delta', delta: 'answer' }
    await new Promise<void>((res) => o.signal.addEventListener('abort', () => res(), { once: true }))
    throw new Error('stream cut')
  },
})

type OutputRow = {
  seq: number
  data: { state?: string; effectId?: string; content?: Array<{ type: string; text: string }> }
}

const outputRows = async (log: { scan: (q: never) => Promise<unknown[]> }) =>
  (await log.scan({ type: 'assistant/output', limit: 50 } as never)) as OutputRow[]

const interruptedText = (rows: OutputRow[]) =>
  rows
    .filter((row) => row.data.state === 'interrupted')
    .flatMap((row) => row.data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

describe('interrupted output is recorded while the process is alive', () => {
  it('a user stop records the text already streamed', async () => {
    const { session, log } = await openSession({ provider: streamThenHang() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await wait(30)
    await session.abort(actor)
    expect((await run).reason).toBe('aborted')

    const rows = await outputRows(log as never)
    expect(rows.filter((row) => row.data.state === 'interrupted')).toHaveLength(1)
    expect(interruptedText(rows)).toBe('partial answer')
    const end = (await log.scan({ type: 'turn/end', limit: 5 }))[0]
    expect(rows.at(-1)?.seq).toBeLessThan(end?.seq ?? 0)
  })

  it('a provider error records the text already streamed', async () => {
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const failing: InferenceEvent[] = [
      sent(),
      { type: 'text_delta', delta: 'half an ' },
      usage(),
      { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'socket died', retryable: false },
    ]
    const { session, log } = await openSession({ provider: fakeProvider([failing]), preset })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })

    const rows = await outputRows(log as never)
    expect(rows.filter((row) => row.data.state === 'interrupted')).toHaveLength(1)
    expect(interruptedText(rows)).toBe('half an ')
  })

  it('closing the session mid-stream keeps the streamed text for the next process', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ provider: streamThenHang(), storage })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect(await first.session.step()).toEqual({ phase: 'checkpoint' })
    expect(await first.session.step()).toEqual({ phase: 'inference' })
    const inference = first.session.step().catch(() => undefined)
    await wait(30)
    // A worker shutting down closes every session it hosts; this is that close, not a kill.
    await first.session.close()
    await inference

    const second = await openSession({ provider: fakeProvider([textTurn('ok')]), storage, key: 'k' })
    const rows = await outputRows(second.log as never)
    const interrupted = rows.filter((row) => row.data.state === 'interrupted')
    expect(interrupted).toHaveLength(1)
    expect(interruptedText(rows)).toBe('partial answer')
    // The close wrote what was said, not how the effect ended: settling it is the next process's job.
    const effectId = interrupted[0]?.data.effectId
    const settled = (await second.log.scan({ type: 'effect/settled', limit: 50 })).filter(
      (row) => (row.data as { effectId?: string }).effectId === effectId,
    )
    expect(settled).toHaveLength(0)
  })
})

describe('a close after the stream has ended keeps the text', () => {
  /** Holds a promise open until the test lets it through. */
  const latch = () => {
    let open!: () => void
    const shut = new Promise<void>((res) => {
      open = res
    })
    return { shut, open }
  }

  const reopened = async (storage: MemoryStorage) => {
    const second = await openSession({ provider: fakeProvider([textTurn('ok')]), storage, key: 'k' })
    return outputRows(second.log as never).then((rows) => ({ second, rows }))
  }

  it('on the error path, while the spend is still being recorded', async () => {
    const storage = new MemoryStorage()
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const failing: InferenceEvent[] = [
      sent(),
      { type: 'text_delta', delta: 'half an ' },
      usage(),
      { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'socket died', retryable: false },
    ]
    const first = await openSession({ provider: fakeProvider([failing]), storage, preset })
    const recording = latch()
    const reached = latch()
    const runtime = (
      first.session as unknown as { d: { runtime: { ledgerRecord: (x: never) => Promise<boolean> } } }
    ).d.runtime
    const ledgerRecord = runtime.ledgerRecord.bind(runtime)
    runtime.ledgerRecord = async (entry: never) => {
      reached.open()
      await recording.shut
      return ledgerRecord(entry)
    }
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await first.session.step()
    await first.session.step()
    const inference = first.session.step().catch(() => undefined)
    await reached.shut
    await first.session.close()
    recording.open()
    await inference

    const { rows } = await reopened(storage)
    expect(rows.filter((row) => row.data.state === 'interrupted')).toHaveLength(1)
    expect(interruptedText(rows)).toBe('half an ')
  })

  it('on the success path, while the last count is still being committed', async () => {
    let now = 1_757_203_200_000
    const provider: Provider = {
      models: () => [],
      async *infer(req): AsyncIterable<InferenceEvent> {
        yield sentFor(req)
        yield { type: 'text_delta', delta: 'the ' }
        now += 6_000
        yield { type: 'text_delta', delta: 'answer' }
        yield usage()
        yield { type: 'done', reason: 'stop' }
      },
    }
    const committing = latch()
    const reached = latch()
    const storage = new MemoryStorage()
    const commit = storage.commit.bind(storage)
    storage.commit = async (key, batch) => {
      if (
        batch.events.some(
          (e) => e.type === 'assistant/output' && (e.data as { state?: string }).state === 'progress',
        )
      ) {
        reached.open()
        await committing.shut
      }
      return commit(key, batch)
    }
    const first = await openSession({ provider, storage, clock: () => now })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await first.session.step()
    await first.session.step()
    const inference = first.session.step().catch(() => undefined)
    await reached.shut
    const closing = first.session.close()
    // The log is sealed before the count's commit is let through.
    await wait(5)
    committing.open()
    await closing
    await inference

    const { second, rows } = await reopened(storage)
    const messages = (await second.log.scan({ type: 'assistant/message', limit: 5 })) as unknown as Array<{
      data: { content: Array<{ type: string; text: string }> }
    }>
    const kept =
      interruptedText(rows) ||
      messages
        .flatMap((m) => m.data.content)
        .map((b) => b.text)
        .join('')
    expect(kept).toBe('the answer')
  })
})

describe('the ledger keeps counts, not streamed text', () => {
  it('writes one start marker, a count at most every five seconds, and the answer once', async () => {
    let now = 1_757_203_200_000
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const provider: Provider = {
      models: () => [],
      async *infer(req): AsyncIterable<InferenceEvent> {
        yield sentFor(req)
        for (let i = 0; i < 12; i++) {
          yield { type: 'text_delta', delta: `part${i} `.repeat(40) }
          now += 1_000
          // Past the 512-character buffer on every delta, so every delta flushes.
        }
        await gate
        yield usage()
        yield { type: 'done', reason: 'stop' }
      },
    }
    const { session, log } = await openSession({ provider, clock: () => now })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const run = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await wait(30)
    release()
    expect((await run).reason).toBe('completed')
    const rows = (await log.scan({ type: 'assistant/output', limit: 50 })) as OutputRow[]
    const states = rows.map((r) => r.data.state)
    expect(states[0]).toBe('started')
    expect(states.slice(1).every((s) => s === 'progress')).toBe(true)
    expect(states.filter((s) => s === 'progress')).toHaveLength(2)
    const counts = rows.map((r) => (r.data as unknown as { chars: { text: number } }).chars.text)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    // No row carries the streamed text, and the finished answer is in the message once.
    expect(rows.every((r) => r.data.content === undefined)).toBe(true)
    expect(await log.scan({ type: 'assistant/message', limit: 5 })).toHaveLength(1)
  })

  it('bills a killed stream from its last count, and shows how much text the kill lost', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ provider: streamThenHang(), storage })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await first.session.step()
    await first.session.step()
    void first.session.step().catch(() => undefined)
    await wait(30)
    // A kill: the log goes away with nothing to abort the inference first.
    await first.log.close()
    const second = await openSession({ provider: fakeProvider([textTurn('ok')]), storage, key: 'k' })
    const [started] = (await second.log.scan({ type: 'assistant/output', limit: 5 })) as unknown as Array<{
      data: { state: string; estimatedTokens: number; chars: { text: number; thinking: number } }
    }>
    expect(started?.data.state).toBe('started')
    await second.session.resume()
    const [cost] = await second.log.scan({ type: 'cost/ledger', limit: 5 })
    expect(cost?.data).toMatchObject({ interrupted: true, tokens: { output: started?.data.estimatedTokens } })
    const node = (await second.session.projectUI()).nodes.find((n) => n.kind === 'assistant')
    expect(node).toMatchObject({ text: '', streaming: false, lostChars: started?.data.chars.text })
  })

  it('keeps the text of a closed stream on screen after the next process resumes it', async () => {
    const storage = new MemoryStorage()
    const first = await openSession({ provider: streamThenHang(), storage })
    await first.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await first.session.step()
    await first.session.step()
    const inference = first.session.step().catch(() => undefined)
    await wait(30)
    await first.session.close()
    await inference
    const second = await openSession({ provider: fakeProvider([textTurn('ok')]), storage, key: 'k' })
    await second.session.resume()
    const [cost] = await second.log.scan({ type: 'cost/ledger', limit: 5 })
    expect(cost?.data).toMatchObject({ interrupted: true, tokens: { output: 4 } })
    const node = (await second.session.projectUI()).nodes.find((n) => n.kind === 'assistant')
    expect(node).toMatchObject({ text: 'partial answer', streaming: false })
    expect(node).not.toHaveProperty('lostChars')
  })

  it('records a stop mid-retry once, and each attempt keeps its own text', async () => {
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 2, baseDelayMs: 1 }
    const flaky: InferenceEvent[] = [
      sent(),
      { type: 'text_delta', delta: 'first try' },
      { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'reset', retryable: true },
    ]
    const { session, log } = await openSession({
      provider: fakeProvider([flaky, textTurn('second')]),
      preset,
      // A moving clock and timers that fire at once, so the retry's wait ends without real time.
      clock: () => Date.now(),
      timers: immediateTimers,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const rows = await outputRows(log as never)
    expect(rows.filter((r) => r.data.state === 'interrupted')).toHaveLength(1)
    expect(interruptedText(rows)).toBe('first try')
    const nodes = (await session.projectUI()).nodes.filter((n) => n.kind === 'assistant')
    expect(nodes.map((n) => (n as { text: string }).text)).toEqual(['first try', 'second'])
  })
})

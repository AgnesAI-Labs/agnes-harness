import type { Event } from '@agnes/core'
import type { FakeProvider } from '@agnes/core/testkit'
import { actor, fakeProvider, type Script, sent, textTurn, toolTurn, usage } from '@agnes/core/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hangingTool, ledgerDir, longPreset, openOn } from './fixture.js'

const signal = () => new AbortController().signal
const delta = (text: string): InferenceEvent => ({ type: 'text_delta', delta: text })

/** Streams its scripts, then never finishes the stream: a process killed mid-inference. */
function hangAfter(provider: FakeProvider, reach: () => void, fromCall = 0): FakeProvider {
  const inner = provider.infer.bind(provider)
  provider.infer = async function* (req, opts) {
    const call = provider.calls
    yield* inner(req, opts)
    if (call < fromCall) return
    reach()
    await new Promise<never>(() => undefined)
  }
  return provider
}

async function all(session: { scan(q: object): Promise<Event[]>; lastSeq: number }, type: string) {
  const rows: Event[] = []
  for (let from = 1; from <= session.lastSeq; from += 500)
    rows.push(...(await session.scan({ fromSeq: from, toSeq: Math.min(session.lastSeq, from + 499), type })))
  return rows
}

// 520 one-call steps, then a two-call batch whose first call finishes and whose second is killed
// mid-run: more than 500 steps, headers, calls and results in one turn, with an open call at the end.
const SINGLE = 520
const batch: Script = [
  sent(),
  { type: 'toolcall_end', call: { toolUseId: '', name: 'step', args: {}, ordinal: 0 }, via: 'native' },
  { type: 'toolcall_end', call: { toolUseId: '', name: 'step', args: { n: 2 }, ordinal: 1 }, via: 'native' },
  usage(),
  { type: 'done', reason: 'toolUse' },
]

describe('recovery of a turn killed after more than 500 steps', () => {
  const inInference = ledgerDir('scan-resume-infer')
  const inTools = ledgerDir('scan-resume-tools')
  let lastNonce: string | undefined
  let lastHeaderSeq: number | undefined

  beforeAll(async () => {
    // Killed while the 521st inference is streaming: 520 calls are on the ledger and no batch is open.
    const storage = inInference.open()
    let reach!: () => void
    const reached = new Promise<void>((r) => {
      reach = r
    })
    const provider = hangAfter(
      fakeProvider([...Array.from({ length: SINGLE }, () => toolTurn('step', {})), [sent()]]),
      reach,
      SINGLE,
    )
    const { session } = await openOn(storage, {
      provider,
      registry: hangingTool(-1).registry,
      preset: longPreset(),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    void session.run({ until: 'turn-end', signal: signal() })
    await reached
    const header = await session.scan({
      type: 'request/header',
      toSeq: session.lastSeq,
      order: 'desc',
      limit: 1,
    })
    lastNonce = (header[0]?.data as { envelopeNonce?: string } | undefined)?.envelopeNonce
    lastHeaderSeq = header[0]?.seq
    await storage.close()
  }, 180_000)
  beforeAll(async () => {
    const storage = inTools.open()
    const { registry, reached } = hangingTool(SINGLE + 1)
    const provider = fakeProvider([...Array.from({ length: SINGLE }, () => toolTurn('step', {})), batch])
    const { session } = await openOn(storage, { provider, registry, preset: longPreset() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    void session.run({ until: 'turn-end', signal: signal() })
    await reached
    await storage.close()
  }, 180_000)
  afterAll(() => {
    inInference.remove()
    inTools.remove()
  })

  it('resumes with the last request header nonce and the next call ordinal after all 520', async () => {
    expect(lastNonce).toBeTruthy()
    const storage = inInference.open(true)
    try {
      const provider = fakeProvider([toolTurn('step', {}), textTurn('done')])
      const { session } = await openOn(storage, {
        provider,
        registry: hangingTool(-1).registry,
        preset: longPreset(),
        writerRunId: 'r2',
      })
      const before = session.lastSeq
      await session.resume()
      // The turn is rebuilt from the newest request header, not the first one of the turn: every
      // header in a turn shares its nonce, so only the seq tells the two apart.
      expect(lastHeaderSeq).toBeGreaterThan(500)
      expect(session.turn?.lastHeaderSeq).toBe(lastHeaderSeq)
      expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
      const headers = await session.scan({
        fromSeq: before + 1,
        toSeq: session.lastSeq,
        type: 'request/header',
      })
      expect(headers.length).toBeGreaterThan(0)
      for (const h of headers) expect((h.data as { envelopeNonce?: string }).envelopeNonce).toBe(lastNonce)
      const calls = await session.scan({ fromSeq: before + 1, toSeq: session.lastSeq, type: 'tool/call' })
      const ordinals = calls.map((c) =>
        Number(/^t(\d+)-/.exec(String((c.data as { toolUseId: string }).toolUseId))?.[1]),
      )
      expect(ordinals).toEqual([SINGLE])
    } finally {
      await storage.close()
    }
  }, 60_000)

  it('closing it writes no second result for a call that already has one', async () => {
    const storage = inTools.open(true)
    try {
      const { session } = await openOn(storage, {
        provider: fakeProvider([]),
        registry: hangingTool(-1).registry,
        preset: longPreset(),
        writerRunId: 'r2',
      })
      await session.resume({ mode: 'close' })
      const results = await all(session, 'tool/result')
      const perCall = new Map<string, number>()
      for (const r of results) {
        const id = String((r.data as { toolUseId: string }).toolUseId)
        perCall.set(id, (perCall.get(id) ?? 0) + 1)
      }
      expect(results).toHaveLength(SINGLE + 2)
      expect([...perCall.values()].filter((n) => n !== 1)).toEqual([])
    } finally {
      await storage.close()
    }
  }, 60_000)
})

// One inference that streamed 600 full-size deltas and was killed before it finished. The text is
// never a ledger row; recovery charges what the last output count recorded. The session clock moves
// five seconds a reading, so every delta records a count and the counts run past one scan page.
it('recovery charges the last recorded output count of a stream killed mid-way', async () => {
  const ledger = ledgerDir('scan-resume-chunks')
  try {
    const storage = ledger.open()
    const CHUNKS = 600
    const piece = (i: number) => String(i % 10).repeat(512)
    let reach!: () => void
    const reached = new Promise<void>((r) => {
      reach = r
    })
    const provider = hangAfter(
      fakeProvider([[sent(), ...Array.from({ length: CHUNKS }, (_, i) => delta(piece(i)))]]),
      reach,
    )
    let now = 1_757_203_200_000
    const { session } = await openOn(storage, {
      provider,
      preset: longPreset(),
      clock: () => (now += 5_000),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    void session.run({ until: 'turn-end', signal: signal() })
    await reached
    const outputs = await all(session, 'assistant/output')
    expect(outputs.length).toBeGreaterThan(500)
    const recorded = (outputs.at(-1)?.data as { estimatedTokens?: number } | undefined)?.estimatedTokens ?? 0
    expect(recorded).toBeGreaterThan(0)
    await storage.close()

    const reopened = ledger.open(true)
    try {
      const { session: again } = await openOn(reopened, {
        provider: fakeProvider([textTurn('done')]),
        preset: longPreset(),
        writerRunId: 'r2',
      })
      await again.resume()
      const costs = (await all(again, 'cost/ledger')).filter(
        (c) => (c.data as { creditSource?: string }).creditSource === 'estimated',
      )
      expect(costs.map((c) => (c.data as { tokens: { output: number } }).tokens.output)).toContain(recorded)
    } finally {
      await reopened.close()
    }
  } finally {
    ledger.remove()
  }
}, 120_000)

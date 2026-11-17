import { SYSTEMONE_ERROR_BODIES } from '@agnes/ai/testkit'
import type { EventEnvelope } from '@agnes/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CALLER,
  DONE_REPLY,
  judgmentDaemon,
  MODEL,
  PACKAGE,
  PROFILE,
  PROMISE_REPLY,
  type TurnCapture,
} from './helpers/daemon.js'

const data = (row: EventEnvelope) => row.data as Record<string, unknown>
const calls = (turn: TurnCapture) =>
  turn.events.filter(
    (row) =>
      row.type === 'x/core/side-call-intent' &&
      (data(row).audit as { caller?: string } | undefined)?.caller === CALLER,
  )
const costs = (turn: TurnCapture) =>
  turn.events.filter((row) => row.type === 'cost/ledger' && data(row).caller === CALLER)
const replies = (turn: TurnCapture) => turn.events.filter((row) => row.type === 'assistant/message')
const enabled = { judge: { route: 'jev-a', model: MODEL }, uses: { stop: { enabled: true } } }

function settledBeforeEnd(turn: TurnCapture) {
  const end = turn.events.find((row) => row.type === 'turn/end')!
  for (const intent of calls(turn)) {
    const binding = data(intent).binding as { effectId: string }
    const settled = turn.events.find(
      (row) => row.type === 'effect/settled' && data(row).effectId === binding.effectId,
    )
    expect(settled, 'every dispatched judgment settles before the turn closes').toBeDefined()
    expect(settled!.seq).toBeLessThan(end.seq)
    expect(data(intent).audit).toMatchObject({ caller: CALLER, label: 'judgment.stop' })
  }
}

describe('optional judgment through the real market, daemon and SDK', () => {
  let fixture: Awaited<ReturnType<typeof judgmentDaemon>>
  beforeAll(async () => {
    fixture = await judgmentDaemon()
  }, 180_000)
  afterAll(async () => {
    await fixture?.close()
  }, 35_000)

  it('not installed: no hooks, no requests', async () => {
    const packages = await fixture.sdk.packages.list({ profile: PROFILE })
    expect(packages.packages.some((pkg) => pkg.id === PACKAGE)).toBe(false)
    const n = fixture.fake.seen.length
    const turn = await fixture.turn(await fixture.session('absent'), 'Inspect synthetic absent sample.')
    expect(fixture.fake.seen.length).toBe(n)
    expect(calls(turn)).toEqual([])
    expect(costs(turn)).toEqual([])
    expect(replies(turn)).toHaveLength(1)
    expect(JSON.stringify(turn.ui.nodes)).toContain(PROMISE_REPLY)
    console.log(JSON.stringify({ measurement: 'judgment-baseline', stoppingMs: turn.stoppingMs }))
  }, 180_000)

  it('installed with default detection off: no requests', async () => {
    await fixture.configure({ judge: { route: 'jev-a', model: MODEL } })
    fixture.respond({}, 0.9)
    const n = fixture.fake.seen.length
    const turn = await fixture.turn(await fixture.session('off'), 'Inspect synthetic default-off sample.')
    expect(fixture.fake.seen.length).toBe(n)
    expect(calls(turn)).toEqual([])
    expect(replies(turn)).toHaveLength(1)
  }, 240_000)

  it('installed but unconfigured: zero side calls over five opted-in turns', async () => {
    // Two native aliases make selection ambiguous; the enabled flag cannot mask the idle path.
    await fixture.configure({ uses: { stop: { enabled: true } } })
    const session = await fixture.session('idle')
    const n = fixture.fake.seen.length
    for (let i = 0; i < 5; i++) {
      const turn = await fixture.turn(session, `Inspect synthetic unconfigured sample ${i}.`)
      expect(calls(turn)).toEqual([])
      expect(costs(turn)).toEqual([])
      expect(replies(turn)).toHaveLength(1)
    }
    expect(fixture.fake.seen.length).toBe(n)
  }, 180_000)

  it('configured: one continuation completes the promised next step and records its caller', async () => {
    await fixture.configure(enabled)
    fixture.respond({}, 0.9)
    const n = fixture.fake.seen.length
    const turn = await fixture.turn(
      await fixture.session('continue'),
      'Inspect synthetic continuation sample.',
    )
    expect(fixture.fake.seen.length - n).toBe(1)
    expect(calls(turn)).toHaveLength(1)
    expect(costs(turn)).toHaveLength(1)
    expect(data(costs(turn)[0]!)).toMatchObject({
      purpose: 'side-call',
      caller: CALLER,
      route: 'jev-a',
      model: MODEL,
    })
    expect(replies(turn)).toHaveLength(2)
    expect(JSON.stringify(data(replies(turn)[0]!))).toContain(PROMISE_REPLY)
    expect(JSON.stringify(turn.ui.nodes)).toContain(DONE_REPLY)
    expect(JSON.stringify(turn.ui.nodes)).toContain('检测到回复说了要做却结束了')
    expect(
      turn.ui.nodes.some(
        (node) => node.kind === 'context' && JSON.stringify(node).includes('检测到回复说了要做却结束了'),
      ),
    ).toBe(true)
    expect(turn.events.filter((row) => row.type === 'x/plugin/524280817e87343c/stop.continued')).toHaveLength(
      1,
    )
    settledBeforeEnd(turn)
    const body = fixture.fake.seen[n]!.body as { state?: unknown }
    expect(JSON.stringify(body.state)).toContain('Inspect synthetic continuation sample.')
    expect(JSON.stringify(body.state)).toContain(PROMISE_REPLY)
  }, 180_000)

  it('a twelve-second judge fails open at its five-second attempt deadline', async () => {
    await fixture.configure(enabled)
    fixture.respond({ delayMs: 12_000 }, 0.9)
    const n = fixture.fake.seen.length
    const turn = await fixture.turn(await fixture.session('slow'), 'Inspect synthetic slow sample.')
    expect(fixture.fake.seen.length - n).toBe(1)
    expect(calls(turn)).toHaveLength(1)
    expect(replies(turn)).toHaveLength(1)
    expect(turn.stoppingMs).toBeGreaterThanOrEqual(4_000)
    expect(turn.stoppingMs).toBeLessThan(8_000)
    settledBeforeEnd(turn)
  }, 35_000)

  it('auth failure cools only this session route and the next turn skips the network', async () => {
    await fixture.configure(enabled)
    fixture.respond({ status: 401, body: SYSTEMONE_ERROR_BODIES.auth })
    const session = await fixture.session('auth')
    const n = fixture.fake.seen.length
    const first = await fixture.turn(session, 'Inspect synthetic auth sample one.')
    expect(fixture.fake.seen.length - n).toBe(1)
    expect(calls(first)).toHaveLength(1)
    settledBeforeEnd(first)
    const second = await fixture.turn(session, 'Inspect synthetic auth sample two.')
    expect(fixture.fake.seen.length - n).toBe(1)
    expect(calls(second)).toEqual([])
    expect(second.stoppingMs).toBeLessThan(2_000)
    const other = await fixture.turn(
      await fixture.session('other-auth'),
      'Inspect synthetic other-session auth sample.',
    )
    expect(fixture.fake.seen.length - n).toBe(2)
    expect(calls(other)).toHaveLength(1)
    settledBeforeEnd(other)
  }, 35_000)

  it('an active goal prevents judgment continuation', async () => {
    await fixture.configure(enabled)
    fixture.respond({}, 0.9)
    const n = fixture.fake.seen.length
    const session = await fixture.session('goal')
    // The goal owns any legitimate automatic next turn; U2 must not add a continuation.
    const turn = await fixture.turn(
      session,
      '/goal create --max-rounds 1 Finish the synthetic sample inspection',
    )
    expect(fixture.fake.seen.length).toBe(n)
    expect(calls(turn)).toEqual([])
    expect(costs(turn)).toEqual([])
    expect(turn.events.some((row) => row.type === 'x/plugin/524280817e87343c/stop.continued')).toBe(false)
  }, 60_000)

  it.each([300, 726, 868, 3000])(
    'measures twenty uncached turns at %i ms injected latency',
    async (delayMs) => {
      await fixture.configure(enabled)
      fixture.respond({ delayMs }, 0.1)
      const session = await fixture.session(`latency-${delayMs}`)
      const samples: number[] = []
      const n = fixture.fake.seen.length
      for (let i = 0; i < 20; i++) {
        const turn = await fixture.turn(
          session,
          `Latency condition ${delayMs}, unique sample ${i}: inspect the synthetic sample.`,
        )
        expect(calls(turn)).toHaveLength(1)
        expect(costs(turn)).toHaveLength(1)
        expect(replies(turn)).toHaveLength(1)
        settledBeforeEnd(turn)
        // These durable commit timestamps exclude boot/install/main inference and include stopping work.
        expect(turn.stoppingMs).toBeGreaterThanOrEqual(delayMs - 25)
        samples.push(turn.stoppingMs)
      }
      expect(fixture.fake.seen.length - n).toBe(20)
      samples.sort((a, b) => a - b)
      const p50 = samples[9]!
      const p95 = samples[18]!
      const within15Seconds = samples.filter((ms) => ms <= 15_000).length / samples.length
      console.log(
        JSON.stringify({
          measurement: 'judgment-stop-latency',
          injectedMs: delayMs,
          samples,
          p50,
          p95,
          max: samples.at(-1),
          within15Seconds,
          thresholdPass: p50 <= 1000 && p95 <= 3000 && within15Seconds >= 0.98,
        }),
      )
      // The 3s stress condition is reported separately; it cannot satisfy the 1s p50 gate.
      expect(within15Seconds).toBeGreaterThanOrEqual(0.98)
    },
    180_000,
  )
})

import { SYSTEMONE_ERROR_BODIES } from '@agnes/ai/testkit'
import { describe, expect, it } from 'vitest'
import { PICK_RESPOND } from './helpers/fake-jev.js'
import {
  bootJevLoop,
  costs,
  data,
  jevAnswers,
  jevDataDir,
  ofType,
  rowsOf,
  runTurn,
  startJev,
  textReply,
  useLoopback,
} from './helpers/host.js'

const reply = [textReply('Answer.')]
const endOf = async (session: Parameters<typeof rowsOf>[0]) =>
  data(ofType(await rowsOf(session), 'turn/end').at(-1))

describe('agnes.jev when Jev fails', () => {
  useLoopback()
  it('records an overflow as MODEL_UNAVAILABLE without retrying and stops at the third', async () => {
    const fake = await startJev({ status: 400, body: SYSTEMONE_ERROR_BODIES.overflow })
    const kit = await bootJevLoop({ dataDir: await jevDataDir(), fake, main: reply })
    try {
      const session = await kit.open('overflow')
      expect((await runTurn(session, 'go')).reason).toBe('error')
      expect(fake.seen).toHaveLength(3)
      expect(await endOf(session)).toMatchObject({ error: { code: 'NO_PROGRESS_LIMIT' } })
      const steps = ofType(await rowsOf(session), 'x/agnes/code/jev.step').map((r) => data(r))
      expect(steps).toHaveLength(3)
      for (const step of steps)
        expect(step).toMatchObject({ route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' })
      expect(costs(await rowsOf(session)).filter((r) => data(r).purpose === 'inference')).toHaveLength(0)
    } finally {
      await kit.host.close()
    }
  })
  it('waits for retry-after on 429 and retries with a new id', async () => {
    const answer = jevAnswers([PICK_RESPOND])
    const fake = await startJev((n, seen) =>
      n === 0 ? { status: 429, headers: { 'retry-after': '1' } } : answer(n - 1, seen),
    )
    const kit = await bootJevLoop({ dataDir: await jevDataDir(), fake, main: reply })
    try {
      const session = await kit.open('retry')
      expect((await runTurn(session, 'go')).reason).toBe('completed')
      expect(fake.seen).toHaveLength(2)
      expect((fake.seen[1]?.at ?? 0) - (fake.seen[0]?.at ?? 0)).toBeGreaterThanOrEqual(900)
      const intents = ofType(await rowsOf(session), 'x/core/side-call-intent').map((r) =>
        JSON.stringify(data(r)),
      )
      expect(intents.some((t) => t.includes('side:jev:1:0:d1'))).toBe(true)
    } finally {
      await kit.host.close()
    }
  })
  it('ends with NO_PROGRESS_LIMIT after three dropped connections', async () => {
    const fake = await startJev({ drop: true })
    const kit = await bootJevLoop({ dataDir: await jevDataDir(), fake, main: reply })
    try {
      const session = await kit.open('drops')
      expect((await runTurn(session, 'go')).reason).toBe('error')
      // A dropped connection is not retried within its step: one request per step.
      expect(fake.seen).toHaveLength(3)
      expect(await endOf(session)).toMatchObject({
        error: { code: 'NO_PROGRESS_LIMIT', message: expect.stringContaining('TRANSPORT') },
      })
    } finally {
      await kit.host.close()
    }
  })
  it('arbitrates once Jev answers again after one failure', async () => {
    const answer = jevAnswers([PICK_RESPOND])
    const fake = await startJev((n, seen) => (n === 0 ? { drop: true } : answer(n - 1, seen)))
    const kit = await bootJevLoop({ dataDir: await jevDataDir(), fake, main: reply })
    try {
      const session = await kit.open('recover')
      expect((await runTurn(session, 'go')).reason).toBe('completed')
      const steps = ofType(await rowsOf(session), 'x/agnes/code/jev.step').map((r) => data(r))
      expect(steps[0]).toMatchObject({ route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' })
      expect(steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
      expect(
        ofType(await rowsOf(session), 'user/message').some((r) =>
          JSON.stringify(data(r)).includes('[recovery note]'),
        ),
      ).toBe(true)
    } finally {
      await kit.host.close()
    }
  })
  it('route missing: names E_MODEL_UNKNOWN and never calls the model', async () => {
    const kit = await bootJevLoop({ dataDir: await jevDataDir(), fake: null, main: reply })
    try {
      const session = await kit.open('missing')
      expect((await runTurn(session, 'go')).reason).toBe('error')
      expect(await endOf(session)).toMatchObject({
        error: { code: 'NO_PROGRESS_LIMIT', message: expect.stringContaining('E_MODEL_UNKNOWN') },
      })
      expect(costs(await rowsOf(session))).toHaveLength(0)
    } finally {
      await kit.host.close()
    }
  })
})

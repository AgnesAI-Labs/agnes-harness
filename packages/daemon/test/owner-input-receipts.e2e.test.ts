import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Harness, openHarness, pause, setUp, until } from './fixtures/owner-input-plugin/index.js'

// Inbound channel receipts end to end: the Host records the owner's chat message before the companion
// sees it, and the companion admits it by receipt id. As in the acceptance cases, each text is unique
// and must show in its session at most once, and never when it must not run.

type Parked = { receiptId: string; service: string; kind: string; text: string; attempts: number }

describe.skipIf(process.platform === 'win32')('owner input receipts on a real daemon', () => {
  let h: Harness
  let pairingId = ''

  beforeAll(async () => {
    h = await openHarness('owner-input-receipts')
    try {
      pairingId = await setUp(h)
    } catch (error) {
      throw new Error(`${String(error)}\nSource daemon stderr:\n${h.stderr()}`, { cause: error })
    }
  }, 240_000)

  afterAll(async () => {
    await h?.close()
  }, 120_000)

  const withLog =
    (work: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      try {
        await work()
      } catch (error) {
        throw new Error(`${String(error)}\nSource daemon stderr:\n${h.stderr().slice(-6000)}`, {
          cause: error,
        })
      }
    }
  const parked = async (sessionId: string) =>
    (
      (await h.owner().request('_agnes/v1/managedInput.get', { sessionId, key: 'none' } as never)) as {
        parkedReceipts: Parked[]
      }
    ).parkedReceipts

  it(
    'owner re-pairs: an acked unadmitted receipt resolves to needsOwner pairingChanged',
    withLog(async () => {
      const task = 're-pair'
      const text = 'OWNER_TEXT_BEFORE_REPAIR'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)
      // The companion acknowledged the message but admitted nothing before the owner paired again.
      const receiptId = await h.ownerSays(text)
      pairingId = await h.pair(pairingId)
      const admitted = await h.admit(sessionId, 'k1', task, { kind: 'ownerMessage', receiptId })
      expect(admitted.value, JSON.stringify(admitted.error)).toMatchObject({
        state: 'needsOwner',
        reason: 'pairingChanged',
        inputId: 'k1',
      })
      await pause(2_000)
      expect(await h.result(sessionId, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'pairingChanged' })
      expect(await h.occurrences(sessionId, text)).toBe(0)
      // The review page shows the input without a text to deliver.
      const view = (await h
        .owner()
        .request('_agnes/v1/managedInput.get', { sessionId, key: 'k1' } as never)) as {
        input: { state: string; text: string | null }
      }
      expect(view.input).toMatchObject({ state: 'needsOwner', text: null })
      // A message after the re-pairing is admitted and runs once.
      const after = 'OWNER_TEXT_AFTER_REPAIR'
      await h.admit(sessionId, 'k2', task, { kind: 'ownerMessage', receiptId: await h.ownerSays(after) })
      await h.reaches(sessionId, 'k2', 'consumed')
      await h.settled(sessionId, 2)
      expect(await h.occurrences(sessionId, after)).toBe(1)
      expect(await h.occurrences(sessionId, text)).toBe(0)
    }),
    240_000,
  )

  it(
    'receipt redelivery and parking: a host crash before ack redelivers the same receiptId; five failures park it; the panel redelivers it',
    withLog(async () => {
      const task = 'redelivery'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)

      // The Host dies while the companion still holds the event, before it acknowledged it.
      const crashText = 'OWNER_TEXT_CRASH_BEFORE_ACK'
      h.control('hang', '1')
      h.inject(crashText)
      const first = await until(() => h.calls().find((call) => call.text === crashText), 'first delivery')
      expect(first.receiptId).toMatch(/^[a-f0-9]{64}$/)
      await h.kill()
      h.control('hang')
      await h.boot()
      const redelivered = await until(
        () => h.handled().find((event) => event.text === crashText),
        'redelivery after the restart',
      )
      expect(redelivered.receiptId, 'the same receipt comes back').toBe(first.receiptId)
      const crashCalls = h.calls().filter((call) => call.text === crashText)
      expect(crashCalls.length).toBeGreaterThanOrEqual(2)
      expect(new Set(crashCalls.map((call) => call.receiptId))).toEqual(new Set([first.receiptId]))
      await h.admit(sessionId, 'k1', task, { kind: 'ownerMessage', receiptId: first.receiptId })
      await h.reaches(sessionId, 'k1', 'consumed')
      await h.settled(sessionId, 2)
      expect(await h.occurrences(sessionId, crashText)).toBe(1)

      // Five failed deliveries park the receipt: each delivery tries the handler three times in process.
      const failText = 'OWNER_TEXT_FIVE_FAILURES'
      h.control('throws', String(5 * 3))
      const event = h.inject(failText)
      const failures = () => h.calls().filter((call) => call.text === failText)
      for (let delivery = 1; delivery <= 5; delivery++) {
        await until(
          () => (failures().length >= delivery * 3 ? true : undefined),
          `delivery ${delivery} of the failing event`,
        )
        await pause(1_000)
        // The channel delivers the same event again, as a platform retries an unacknowledged event.
        if (delivery < 5)
          h.inject(failText, { eventId: event.eventId, messageId: event.messageId, at: event.at })
      }
      const parkedId = failures()[0]?.receiptId
      if (!parkedId) throw new Error('the failing event carried no receipt id')
      expect(new Set(failures().map((call) => call.receiptId))).toEqual(new Set([parkedId]))
      const listed = await until(
        async () => (await parked(sessionId)).find((receipt) => receipt.receiptId === parkedId),
        'parked receipt on the review page',
      )
      expect(listed).toMatchObject({ text: failText, kind: 'message', service: 'companion', attempts: 5 })
      expect(failures()).toHaveLength(15)
      // Parked: a further delivery of the same event no longer reaches the companion.
      h.inject(failText, { eventId: event.eventId, messageId: event.messageId, at: event.at })
      await pause(3_000)
      expect(failures()).toHaveLength(15)
      expect(h.handled().some((row) => row.text === failText)).toBe(false)

      // The owner redelivers it from the review page; the companion handles it this time.
      expect(h.controlValue('throws')).toBe('0')
      const decided = await h.owner().request('_agnes/v1/managedInput.decide', {
        sessionId,
        target: { kind: 'receipt', receiptId: parkedId, decision: 'redeliver' },
      } as never)
      expect(decided).toEqual({ receipt: 'pending' })
      const handled = await until(() => h.handled().find((row) => row.text === failText), 'panel redelivery')
      expect(handled.receiptId).toBe(parkedId)
      expect(await parked(sessionId)).toEqual([])
      await h.admit(sessionId, 'k2', task, { kind: 'ownerMessage', receiptId: parkedId })
      await h.reaches(sessionId, 'k2', 'consumed')
      await h.settled(sessionId, 3)
      expect(await h.occurrences(sessionId, failText)).toBe(1)
    }),
    300_000,
  )
})

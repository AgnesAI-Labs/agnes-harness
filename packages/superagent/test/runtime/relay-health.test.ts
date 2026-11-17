// A relay to the main session that keeps failing holds back every later one, as relays are ordered. The `relay` health
// entry then names what waits.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Effects, FAILURES_BEFORE_ERROR } from '../../src/app/effects.js'
import { followupRelay, resultRelay } from '../../src/app/notices.js'
import { HealthBoard } from '../../src/infra/health.js'
import { sessionNotices } from '../../src/runtime/app-core.js'
import { SessionDelivery } from '../../src/runtime/delivery.js'
import { SessionRegistry, Sessions } from '../../src/runtime/sessions.js'
import { fakeClient } from './fake-sdk.js'
import { tempStore, ticket } from './helpers.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

async function setup() {
  const fake = fakeClient()
  const sessions = new Sessions({
    client: fake.client,
    registry: new SessionRegistry(temp.store),
    orchestratorDir: () => temp.dir,
    prepareCommand: () => '',
    environment: () => ({}),
    lifetime: new AbortController().signal,
  })
  const id = await sessions.ensureOrchestrator()
  const board = new HealthBoard()
  const effects = new Effects(temp.store, board)
  const notices = sessionNotices({
    store: temp.store,
    effects,
    delivery: new SessionDelivery({ sessions, store: temp.store }),
    log: { warn: () => {} },
  })
  effects.start()
  const rerun = async () => {
    temp.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'relay'").run()
    await effects.idle('relay')
  }
  return { session: fake.sessions.get(id)!, board, effects, notices, rerun }
}

it('names the ticket whose relay waits on the relay health entry, and clears it once the relay went through', async () => {
  const { session, board, effects, notices, rerun } = await setup()
  // The first submission's answer is lost and the daemon cannot confirm it either: each try waits on that check.
  session.failNext = 'lost'
  session.checkFails = true
  const report = resultRelay(ticket('T-7'), 'done', 'Fixed the login')
  notices.relay(report.id, report.text)
  await effects.idle('relay')
  for (let n = 1; n < FAILURES_BEFORE_ERROR; n++) await rerun()
  expect(board.all.relay).toMatchObject({ state: 'error' })
  expect(board.all.relay?.detail).toContain(
    `The relay of ticket T-7 (${report.id}) waits to reach the main session: UNCERTAIN`,
  )
  // Once the daemon can confirm it, the relay goes through and the entry is ready again.
  session.checkFails = false
  await rerun()
  expect(board.all.relay).toMatchObject({ state: 'ready' })
  await effects.drain()
})

it('names the trigger of a follow-up relay', async () => {
  const { session, board, effects, notices, rerun } = await setup()
  session.failNext = 'lost'
  session.checkFails = true
  const followup = followupRelay({ trigger_id: 'github:42' }, [])
  notices.relay(followup.id, followup.text)
  await effects.idle('relay')
  for (let n = 1; n < FAILURES_BEFORE_ERROR; n++) await rerun()
  expect(board.all.relay?.detail).toContain(
    'The follow-up relay of trigger github:42 waits to reach the main session',
  )
  await effects.drain()
})

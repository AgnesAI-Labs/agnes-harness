import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bounded } from './fixtures/managed-probe.js'
import { COMPANION, type Harness, openHarness, pause, setUp } from './fixtures/owner-input-plugin/index.js'

// Every case checks that an owner input enters its session at most once: the text is unique to the
// case, and the session view (every user message and every rendered node) shows it once when it ran
// and never when it must not run. A `user/message` carrying the input's commandId also carries its
// text, so one occurrence of the text bounds the messages for that commandId to one.

/** Seeds the old `send` ledger of a stopped daemon, as a pre-upgrade daemon left it. */
function seedSend(root: string, sessionId: string, key: string, state: 'pending' | 'sent') {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      const stat = statSync(full, { throwIfNoEntry: false })
      return stat?.isDirectory() ? files(full) : stat?.isFile() ? [full] : []
    })
  for (const file of files(root).filter((path) => /\.(db|sqlite|sqlite3)$/.test(path))) {
    const db = new DatabaseSync(file)
    try {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_session_sends'")
        .get()
      if (!table) continue
      const record = db.prepare('SELECT owner FROM managed_sessions WHERE session_id = ?').get(sessionId) as
        | { owner: string }
        | undefined
      if (!record) throw new Error(`no managed session record for ${sessionId}`)
      db.prepare(
        'INSERT INTO managed_session_sends (owner, session_id, idempotency_key, state) VALUES (?, ?, ?, ?)',
      ).run(record.owner, sessionId, key, state)
      return
    } finally {
      db.close()
    }
  }
  throw new Error('no daemon database holds the managed session sends')
}

describe.skipIf(process.platform === 'win32')('owner input admission on a real daemon', () => {
  let h: Harness

  beforeAll(async () => {
    h = await openHarness('owner-input-acceptance')
    try {
      await setUp(h)
    } catch (error) {
      throw new Error(`${String(error)}\nSource daemon stderr:\n${h.stderr()}`, { cause: error })
    }
  }, 240_000)

  afterAll(async () => {
    await h?.close()
  }, 120_000)

  const ownerMessage = (receiptId: string) => ({ kind: 'ownerMessage', receiptId })
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

  it(
    'killed after the record is written: retry returns the same inputId and the text runs once',
    withLog(async () => {
      const task = 'after-reserve'
      const text = 'OWNER_TEXT_AFTER_RESERVE'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)
      const input = ownerMessage(await h.ownerSays(text))
      h.arm('afterReserve')
      const forget = h.fire('sessions.admitInput', sessionId, { key: 'k1', target: h.target(task), input })
      expect(await h.crashed(), 'the daemon died at the armed point').toEqual({
        signal: 'SIGKILL',
        armed: [],
      })
      forget()
      await h.boot()
      // The record outlived the crash, not yet complete: the caller is told to admit again.
      expect(await h.result(sessionId, 'k1')).toMatchObject({ state: 'queued', inputId: 'k1' })
      expect(await h.occurrences(sessionId, text)).toBe(0)
      const retried = await h.admit(sessionId, 'k1', task, input)
      expect(retried.value, JSON.stringify(retried.error)).toMatchObject({ inputId: 'k1' })
      const consumed = await h.reaches(sessionId, 'k1', 'consumed')
      await h.settled(sessionId, 2)
      expect(await h.occurrences(sessionId, text)).toBe(1)
      expect((await h.admit(sessionId, 'k1', task, input)).value).toEqual(consumed)
      await pause(1_000)
      expect(await h.occurrences(sessionId, text)).toBe(1)
    }),
    240_000,
  )

  it(
    'killed after the core enqueue: after restart the input runs once through commandId dedupe',
    withLog(async () => {
      const task = 'after-submit'
      const text = 'OWNER_TEXT_AFTER_SUBMIT'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)
      const input = ownerMessage(await h.ownerSays(text))
      h.arm('afterSubmit')
      const forget = h.fire('sessions.admitInput', sessionId, { key: 'k1', target: h.target(task), input })
      expect(await h.crashed(), 'the daemon died at the armed point').toEqual({
        signal: 'SIGKILL',
        armed: [],
      })
      forget()
      await h.boot()
      // The startup sweep settles the submission that was never confirmed; nothing is queued twice.
      const consumed = await h.reaches(sessionId, 'k1', 'consumed')
      expect(consumed).toMatchObject({ inputId: 'k1', turn: expect.any(Number), seq: expect.any(Number) })
      await h.settled(sessionId, 2)
      await pause(1_000)
      expect(await h.occurrences(sessionId, text)).toBe(1)
      expect((await h.admit(sessionId, 'k1', task, input)).value).toEqual(consumed)
    }),
    240_000,
  )

  it(
    'busy restart: a held input survives SIGTERM and runs once after the startup sweep or inputResult',
    withLog(async () => {
      const task = 'busy-restart'
      const text = 'OWNER_TEXT_BUSY_RESTART'
      const held = h.provider.hold()
      const sessionId = await h.start(task, 'HOLD_THIS_TURN while the owner writes.')
      await bounded(held.entered, 'held first turn')
      const input = ownerMessage(await h.ownerSays(text))
      const admitted = await h.admit(sessionId, 'k1', task, input)
      expect(admitted.value, JSON.stringify(admitted.error)).toMatchObject({
        state: 'enqueued',
        reason: 'busy',
        inputId: 'k1',
      })
      expect(await h.occurrences(sessionId, text)).toBe(0)
      // SIGTERM while the turn is still running: the daemon aborts it on the way down.
      await h.stop()
      held.release()
      await h.boot()
      await h.reaches(sessionId, 'k1', 'consumed')
      await pause(1_000)
      expect(await h.occurrences(sessionId, text)).toBe(1)
    }),
    240_000,
  )

  it(
    'consumed then reply lost: inputResult returns consumed with turn and seq',
    withLog(async () => {
      const task = 'reply-lost'
      const text = 'OWNER_TEXT_REPLY_LOST'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)
      const input = ownerMessage(await h.ownerSays(text))
      // The companion never reads this reply: it learns the outcome only from inputResult.
      await h.admit(sessionId, 'k1', task, input)
      await h.settled(sessionId, 2)
      const result = await h.result(sessionId, 'k1')
      expect(result).toMatchObject({
        state: 'consumed',
        inputId: 'k1',
        reason: 'eligible',
        turn: expect.any(Number),
        seq: expect.any(Number),
      })
      expect(result.seq).toBeGreaterThan(0)
      expect(await h.result(sessionId, 'k1')).toEqual(result)
      expect((await h.admit(sessionId, 'k1', task, input)).value).toEqual(result)
      expect(await h.occurrences(sessionId, text)).toBe(1)
    }),
    240_000,
  )

  it(
    'same key with a different request is refused OWNER_INPUT_KEY_REUSED and nothing new runs',
    withLog(async () => {
      const task = 'key-reused'
      const first = 'OWNER_TEXT_KEY_FIRST'
      const second = 'OWNER_TEXT_KEY_SECOND'
      const sessionId = await h.start(task)
      await h.settled(sessionId, 1)
      await h.admit(sessionId, 'k1', task, ownerMessage(await h.ownerSays(first)))
      const consumed = await h.reaches(sessionId, 'k1', 'consumed')
      await h.settled(sessionId, 2)
      const refused = await h.admit(sessionId, 'k1', task, ownerMessage(await h.ownerSays(second)))
      expect(refused.ok).toBe(false)
      expect(refused.error?.data).toMatchObject({
        code: 'CAPABILITY_DENIED',
        reason: 'OWNER_INPUT_KEY_REUSED',
      })
      await pause(2_000)
      expect(await h.result(sessionId, 'k1')).toEqual(consumed)
      expect(await h.occurrences(sessionId, first)).toBe(1)
      expect(await h.occurrences(sessionId, second)).toBe(0)
    }),
    240_000,
  )

  it(
    'archived by the plugin or by the owner in the Web: the held input turns retained sessionArchived and never runs',
    withLog(async () => {
      for (const by of ['plugin', 'owner'] as const) {
        const task = `archived-by-${by}`
        const text = `OWNER_TEXT_ARCHIVED_BY_${by.toUpperCase()}`
        const held = h.provider.hold()
        const sessionId = await h.start(task, `HOLD_THIS_TURN until it is archived by the ${by}.`)
        await bounded(held.entered, 'held first turn')
        const admitted = await h.admit(sessionId, 'k1', task, ownerMessage(await h.ownerSays(text)))
        expect(admitted.value, JSON.stringify(admitted.error)).toMatchObject({
          state: 'enqueued',
          reason: 'busy',
        })
        if (by === 'plugin') expect((await h.companion('sessions.archive', sessionId)).ok).toBe(true)
        else await h.owner().request('_agnes/v1/session.archive', { sessionId, archived: true })
        held.release()
        const retained = await h.reaches(sessionId, 'k1', 'retained')
        expect(retained, by).toMatchObject({ reason: 'sessionArchived' })
        await pause(2_000)
        expect(await h.result(sessionId, 'k1')).toEqual(retained)
        expect(await h.occurrences(sessionId, text), by).toBe(0)
      }
    }),
    240_000,
  )

  it(
    'legacy migration: legacySend consumed/pending/unknown, legacyOwnerMessage recoveryUnknown until the owner delivers it in the Web',
    withLog(async () => {
      const task = 'legacy'
      const legacyText = 'OWNER_TEXT_LEGACY_MESSAGE'
      // A session opened before task bindings existed, driven with the old `send`.
      const sessionId = await h.start(task, 'Start legacy.', false)
      await h.settled(sessionId, 1)
      const sent = await h.companion('sessions.send', sessionId, {
        text: 'LEGACY_SEND_TEXT',
        idempotencyKey: 'old-1',
      })
      expect(sent.value, JSON.stringify(sent.error)).toEqual({ state: 'started' })
      await h.settled(sessionId, 2)
      // The upgraded daemon finds the old ledger as the old one left it: one send interrupted after it
      // was recorded, one recorded as sent whose message is nowhere in the session.
      await h.stop()
      seedSend(h.root, sessionId, 'old-2', 'pending')
      seedSend(h.root, sessionId, 'old-3', 'sent')
      await h.boot()
      expect(await h.result(sessionId, 'old-1')).toEqual({ state: 'legacySend', delivery: 'consumed' })
      expect(await h.result(sessionId, 'old-2')).toEqual({ state: 'legacySend', delivery: 'pending' })
      expect(await h.result(sessionId, 'old-3')).toEqual({ state: 'legacySend', delivery: 'unknown' })
      expect(await h.occurrences(sessionId, 'LEGACY_SEND_TEXT')).toBe(1)

      // The first admission binds the session to its task, once.
      const legacy = { kind: 'legacyOwnerMessage', text: legacyText, originalInbox: null }
      const admitted = await h.admit(sessionId, 'legacy-1', task, legacy)
      expect(admitted.value, JSON.stringify(admitted.error)).toMatchObject({
        state: 'recoveryUnknown',
        reason: 'legacySourceUnknown',
        reviewLocation: `/?session=${encodeURIComponent(sessionId)}&ownerInput=legacy-1`,
      })
      const elsewhere = await h.companion('sessions.admitInput', sessionId, {
        key: 'legacy-2',
        target: { taskId: 'another-task', taskGeneration: 0, startKey: task },
        input: legacy,
      })
      expect(elsewhere.error?.data).toMatchObject({ reason: 'OWNER_INPUT_TARGET_MISMATCH' })
      const old = await h.companion('sessions.send', sessionId, { text: 'x', idempotencyKey: 'old-4' })
      expect(old.error?.data).toMatchObject({ reason: 'OWNER_INPUT_REQUIRED' })
      await pause(2_000)
      expect(await h.result(sessionId, 'legacy-1')).toMatchObject({ state: 'recoveryUnknown' })
      expect(await h.occurrences(sessionId, legacyText)).toBe(0)

      // Only the owner's Web page reads and decides it; a local SDK client on the Unix socket cannot.
      const read = { sessionId, key: 'legacy-1' }
      await expect(h.sdk().request('_agnes/v1/managedInput.get', read as never)).rejects.toMatchObject({
        message: expect.stringContaining('CAPABILITY_DENIED'),
      })
      const view = (await h.owner().request('_agnes/v1/managedInput.get', read as never)) as {
        input: { text: string; state: string; kind: string; version: number }
      }
      expect(view.input).toMatchObject({
        text: legacyText,
        state: 'recoveryUnknown',
        kind: 'legacyOwnerMessage',
      })
      const decided = await h.owner().request('_agnes/v1/managedInput.decide', {
        sessionId,
        target: { kind: 'input', key: 'legacy-1', decision: 'deliver', version: view.input.version },
      } as never)
      expect(decided).toMatchObject({ state: 'enqueued' })
      await h.reaches(sessionId, 'legacy-1', 'consumed')
      await h.settled(sessionId, 3)
      expect(await h.occurrences(sessionId, legacyText)).toBe(1)
    }),
    240_000,
  )

  it(
    'revoked grant: held input needsOwner grantRevoked, submitted input withdrawn from the inbox, neither runs',
    withLog(async () => {
      const heldText = 'OWNER_TEXT_REVOKED_HELD'
      const queuedText = 'OWNER_TEXT_REVOKED_QUEUED'
      // Submitted into the core inbox of a session whose turn the owner paused: the daemon closed that turn
      // on its way down, and the pause still fences the inbox, so no turn takes the input.
      let held = h.provider.hold()
      const paused = await h.start('revoke-queued', 'HOLD_THIS_TURN until the owner pauses.')
      await bounded(held.entered, 'held first turn')
      const control = (action: 'pause' | 'resume') =>
        h.owner().request('_agnes/v1/session.control', {
          sessionId: paused,
          action,
          commandId: randomUUID(),
        } as never)
      await control('pause')
      await h.stop()
      held.release()
      await h.boot()
      await h.settled(paused, 1)
      const queued = await h.admit(paused, 'k1', 'revoke-queued', ownerMessage(await h.ownerSays(queuedText)))
      expect(queued.value, JSON.stringify(queued.error)).toMatchObject({
        state: 'enqueued',
        reason: 'eligible',
      })
      await pause(1_000)
      expect(await h.result(paused, 'k1')).toMatchObject({ state: 'enqueued', reason: 'eligible' })
      const inbox = async () =>
        JSON.stringify(
          (
            (await h.owner().request('_agnes/v1/session.controls', { sessionId: paused } as never)) as {
              pending: unknown[]
            }
          ).pending,
        )
      expect(await inbox(), 'the input waits in the core inbox').toContain(queuedText)
      // Held by the platform: its session is busy.
      held = h.provider.hold()
      const busy = await h.start('revoke-held', 'HOLD_THIS_TURN while the grant is revoked.')
      await bounded(held.entered, 'held first turn')
      const kept = await h.admit(busy, 'k1', 'revoke-held', ownerMessage(await h.ownerSays(heldText)))
      expect(kept.value, JSON.stringify(kept.error)).toMatchObject({ state: 'enqueued', reason: 'busy' })

      await h
        .sdk()
        .request('_agnes/v1/admin.managedWorkspaces.revoke', { packageId: COMPANION, workspace: h.workspace })
      expect(await h.result(busy, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      expect(await h.result(paused, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      expect(await inbox(), 'the revoke took it back from the core inbox').not.toContain(queuedText)
      // Neither runs once the turn ends and the session is resumed.
      held.release()
      await control('resume')
      await h.settled(busy, 1)
      await pause(2_000)
      expect(await h.occurrences(busy, heldText)).toBe(0)
      expect(await h.occurrences(paused, queuedText)).toBe(0)
      expect(await h.result(paused, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      await h
        .sdk()
        .request('_agnes/v1/admin.managedWorkspaces.grant', { packageId: COMPANION, workspace: h.workspace })
    }),
    240_000,
  )
})

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OwnerInputTrace } from '../src/supervisor/managed-input-trace.js'
import { bounded } from './fixtures/managed-probe.js'
import { COMPANION, type Harness, openHarness, pause, setUp } from './fixtures/owner-input-plugin/index.js'

// A full-access managed session, as the companion's workers run, holds an owner input while its turn
// runs; the daemon stops and starts again. A restarted daemon has not probed its sandbox until a
// workspace binds, so the first gate read after the restart finds L1 `unprobed`: that is no answer,
// and the input stays held until the gates pass. A grant that is really gone still parks it.

/** Deletes every managed workspace grant of a stopped daemon, as a revoke that ran before a crash. */
function dropGrants(root: string) {
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
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_session_grants'")
        .get()
      if (!table) continue
      const dropped = db.prepare('DELETE FROM managed_session_grants').run().changes
      if (dropped === 0) throw new Error('no managed workspace grant to drop')
      return
    } finally {
      db.close()
    }
  }
  throw new Error('no daemon database holds the managed workspace grants')
}

describe.skipIf(process.platform === 'win32')('owner input across a restart of a full-access session', () => {
  let h: Harness

  beforeAll(async () => {
    h = await openHarness('owner-input-busy-restart')
    try {
      await setUp(h)
      // The companion's judge runs in a default session first; its workspace binding runs the probe, so
      // a full-access worker can start. A fresh daemon refuses full access until then.
      const judge = await h.start('judge')
      await h.settled(judge, 1)
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
        const trace = h
          .trace()
          .map((entry) => JSON.stringify(entry))
          .join('\n')
        throw new Error(
          `${String(error)}\nOwner input trace:\n${trace.slice(-6000)}\nSource daemon stderr:\n${h.stderr().slice(-4000)}`,
          { cause: error },
        )
      }
    }
  /** A full-access session whose first turn is still running, holding the owner's `text` under `k1`. */
  const heldInRunningTurn = async (task: string, text: string) => {
    const held = h.provider.hold()
    const sessionId = await h.start(task, 'HOLD_THIS_TURN while the owner writes.', true, {
      permission: 'full-access',
    })
    await bounded(held.entered, 'held first turn')
    const admitted = await h.admit(sessionId, 'k1', task, ownerMessage(await h.ownerSays(text)))
    expect(admitted.value, JSON.stringify(admitted.error)).toMatchObject({
      state: 'enqueued',
      reason: 'busy',
      inputId: 'k1',
    })
    return { sessionId, held }
  }
  const after = (mark: number, sessionId: string) =>
    h
      .trace()
      .slice(mark)
      .filter((entry) => entry.sessionId === sessionId)

  it(
    'L1 unprobed at the first gate read after restart: the original key is held, then runs exactly once',
    withLog(async () => {
      const task = 'busy-full-access'
      const text = 'OWNER_TEXT_BUSY_FULL_ACCESS'
      const { sessionId, held } = await heldInRunningTurn(task, text)
      const mark = h.trace().length
      await h.stop()
      held.release()
      await h.boot()
      // Another key's continuation of the interrupted turn: whatever becomes of it, it is not the original input.
      const { events } = (
        await h.companion<{ events: { kind: string; seq: number; status?: string }[] }>(
          'sessions.events',
          sessionId,
        )
      ).value ?? { events: [] }
      const interrupted = events.filter(
        (event) => event.kind === 'turn' && (event.status === 'cancelled' || event.status === 'failed'),
      )
      const continuation = interrupted.at(-1)
        ? await h.admit(sessionId, 'k2', task, {
            kind: 'recoveryContinuation',
            turnEndSeq: interrupted.at(-1)?.seq,
          })
        : undefined
      const consumed = await h.reaches(sessionId, 'k1', 'consumed')
      expect(consumed).toMatchObject({ inputId: 'k1', turn: expect.any(Number), seq: expect.any(Number) })
      await h.settled(sessionId, 2)
      await pause(1_000)
      expect(await h.occurrences(sessionId, text)).toBe(1)
      expect(await h.result(sessionId, 'k1')).toEqual(consumed)
      if (continuation?.value) {
        const other = await h.result(sessionId, 'k2')
        expect(other.inputId).toBe('k2')
        if (other.state === 'consumed') expect(other.seq).not.toBe(consumed.seq)
      }

      const lines = after(mark, sessionId)
      // The first gate read after the restart found the probe not yet run, opened the session, read again.
      const first = lines.find((entry) => entry.gate !== undefined) as OwnerInputTrace
      expect(first.gate).toMatchObject({ reopenedAfter: 'unprobed' })
      expect(['startup-sweep', 'inputResult', 'admit']).toContain(first.trigger)
      const original = lines.filter((entry) => entry.key === 'k1')
      expect(original.some((entry) => entry.to?.startsWith('needsOwner'))).toBe(false)
      expect(original.filter((entry) => entry.to === 'consumed/eligible')).toHaveLength(1)
      expect(JSON.stringify(lines)).not.toContain(text)
    }),
    240_000,
  )

  it(
    'a grant gone at restart: the held input is parked grantRevoked, never delivered, and the trace names the gate',
    withLog(async () => {
      const task = 'busy-revoked'
      const text = 'OWNER_TEXT_BUSY_REVOKED'
      const { sessionId, held } = await heldInRunningTurn(task, text)
      const mark = h.trace().length
      await h.stop()
      held.release()
      dropGrants(h.root)
      await h.boot()
      expect(await h.reaches(sessionId, 'k1', 'needsOwner')).toMatchObject({ reason: 'grantRevoked' })
      await h.settled(sessionId, 1)
      await pause(2_000)
      expect(await h.occurrences(sessionId, text)).toBe(0)
      const parked = after(mark, sessionId).find(
        (entry) => entry.key === 'k1' && entry.to === 'needsOwner/grantRevoked',
      )
      expect(parked).toMatchObject({
        from: 'enqueued/busy',
        gate: { verdict: 'refused', gate: 'workspace', code: 'WORKSPACE_NOT_AUTHORIZED' },
      })
      expect(['startup-sweep', 'inputResult']).toContain(parked?.trigger)
      // A new grant does not deliver it: a parked input waits for the owner's decision.
      await h
        .sdk()
        .request('_agnes/v1/admin.managedWorkspaces.grant', { packageId: COMPANION, workspace: h.workspace })
      await h.result(sessionId, 'k1')
      await pause(1_000)
      expect(await h.result(sessionId, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      expect(await h.occurrences(sessionId, text)).toBe(0)
    }),
    240_000,
  )
})

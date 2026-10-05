import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { stableId } from '../../src/runtime/state/records.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'

describe('original Effects Action commit proof', () => {
  it('rejects an unrelated ledger event at the recorded creation sequence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-effects-source-'))
    const inputFixture = admissionFixtureInput()
    const fixture = await openJointAdmission(directory, inputFixture)
    try {
      const created = await fixture.coordinator.coordinate(fixture.draft(), fixture.context())
      expect(created.ok && created.value.state).toBe('created')
      const opened = await fixture.state.open({
        requestId: 'effects-writer',
        authority: fixture.binding.stateAuthorityAtCreation,
        sessionId: fixture.draft().admission.sessionId,
        mode: 'write',
        writerId: 'effects-writer',
        ttlMs: 600000,
      })
      if (!opened.claim) throw Error('actual State writer was not opened')
      const writerEpoch = opened.claim.writerEpoch
      const selected = fixture.binding.providers.find((row) =>
        row.descriptor.operations.some((operation) => operation.kind === 'action'),
      )
      const operation = selected?.descriptor.operations.find((entry) => entry.kind === 'action')
      if (!selected || !operation) throw Error('original action provider absent')
      const input = { ...fixtureRef({}), schema: operation.inputSchema }
      const intent = {
        key: 'original-effect',
        target: selected.binding,
        method: operation.method,
        input,
        dependencies: [],
        retry: { mode: 'never' as const, maxAttempts: 0, backoffMs: [] },
        obligation: 'mandatory' as const,
        deadline: '2027-01-01T00:00:00Z',
        resultSchema: operation.outputSchema,
        references: [],
      }
      const invocationId = 'effects-invocation'
      await fixture.state.admitInvocation({
        requestId: 'effects-invoke',
        runId: fixture.draft().admission.runId,
        targetActionId: null,
        baseRevision: 0,
        bindingId: fixture.binding.bindingId,
        writerEpoch,
        invocationId,
        deadline: intent.deadline,
        queryAllowance: 0,
      })
      await fixture.state.closeInvocation({
        requestId: 'effects-close',
        invocationId,
        state: 'prepared',
        readGuards: [],
        domainReads: [],
        unresolvedInflightIds: [],
        observedQueryCount: 0,
      })
      await fixture.state.advanceRun({
        commitId: 'effects-advance',
        guard: {
          authority: fixture.binding.stateAuthorityAtCreation,
          sessionId: fixture.draft().admission.sessionId,
          runId: fixture.draft().admission.runId,
          writerId: 'effects-writer',
          writerEpoch,
          expectedRunRevision: 0,
          bindingId: fixture.binding.bindingId,
          invocationId,
          readGuards: [],
          queryUsage: null,
        },
        transition: {
          expectedRevision: 0,
          continuation: {
            namespace: 'agh.test',
            codecVersion: '1',
            data: fixtureRef({}),
            provenance: { sourceRefs: [], producer: selected.binding, trustLabels: [] },
            createdAt: fixture.draft().admission.admittedAt,
            references: [],
          },
          consumeSignals: [],
          actions: [{ ...intent, intentFingerprint: fixtureHash(intent) }],
          next: { kind: 'continue' },
        },
      })
      const actionId = stableId('act', `${fixture.draft().admission.runId}\0${intent.key}`)
      const side = fixture.db
        .prepare("SELECT identity FROM runtime_side_entries WHERE kind='action-created' AND identity=?")
        .get(actionId) as { identity: string } | undefined
      if (!side) throw Error('original action-created side absent')
      fixture.state.installEffectsActionCapture()
      const captured = await fixture.state.captureEffectsAction(fixture.draft().admission.sessionId, actionId)
      expect(captured.actionId).toBe(actionId)
      const commitId = captured.createdByCommitId
      const proof = fixture.db
        .prepare('SELECT ledger_seq FROM runtime_commit_proofs WHERE commit_id=?')
        .get(commitId)
      if (!proof || typeof proof.ledger_seq !== 'number') throw Error('original commit proof missing')
      const ledgerSeq = proof.ledger_seq
      expect(await fixture.state.verifyEffectsActionCapture(captured)).toBe(true)
      const sessionId = captured.sessionId
      const before = fixture.db
        .prepare('SELECT type,data FROM events WHERE session_key=? AND seq=?')
        .get(sessionId, proof.ledger_seq)
      if (!before || typeof before.type !== 'string' || typeof before.data !== 'string')
        throw Error('original event missing')
      const originalType = before.type,
        originalData = before.data
      const restore = () =>
        fixture.db
          .prepare('UPDATE events SET type=?,data=? WHERE session_key=? AND seq=?')
          .run(originalType, originalData, sessionId, ledgerSeq)
      try {
        fixture.db
          .prepare('UPDATE events SET type=? WHERE session_key=? AND seq=?')
          .run('unrelated-event', sessionId, proof.ledger_seq)
        const writes = fixture.db.prepare('SELECT total_changes() AS count').get()
        await expect(fixture.state.captureEffectsAction(sessionId, actionId)).rejects.toThrow()
        await expect(fixture.state.verifyEffectsActionCapture(captured)).rejects.toThrow()
        expect(fixture.db.prepare('SELECT total_changes() AS count').get()).toEqual(writes)
        restore()
        fixture.db
          .prepare('UPDATE events SET data=? WHERE session_key=? AND seq=?')
          .run(
            JSON.stringify({ ...JSON.parse(before.data), commitId: 'unrelated-commit' }),
            sessionId,
            proof.ledger_seq,
          )
        const writesAfterTamper = fixture.db.prepare('SELECT total_changes() AS count').get()
        await expect(fixture.state.captureEffectsAction(sessionId, actionId)).rejects.toThrow()
        await expect(fixture.state.verifyEffectsActionCapture(captured)).rejects.toThrow()
        expect(fixture.db.prepare('SELECT total_changes() AS count').get()).toEqual(writesAfterTamper)
      } finally {
        restore()
      }
      expect((await fixture.state.captureEffectsAction(sessionId, actionId)).createdByCommitId).toBe(commitId)
      expect(await fixture.state.verifyEffectsActionCapture(captured)).toBe(true)
    } finally {
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

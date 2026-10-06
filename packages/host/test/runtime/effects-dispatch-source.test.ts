import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { bodyDigest, stableId } from '../../src/runtime/state/records.js'
import { RuntimeStateDatabase, runtimeStateUsesDatabase } from '../../src/runtime/state/transactions.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { fixtureHash, fixtureRef } from './fixtures/assembly-maintenance-wire.js'

describe('original Effects dispatch source', () => {
  it('binds a committed prepared Action to its original selected operation and live State lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-effects-source-'))
    const inputFixture = admissionFixtureInput()
    const fixedNow = inputFixture.fixture.now
    let clockHook = () => {}
    Object.defineProperty(inputFixture.fixture, 'now', {
      get: () => {
        clockHook()
        return fixedNow
      },
    })
    let beforeSourceCommit = () => {}
    const fixture = await openJointAdmission(directory, inputFixture, (point) => {
      if (point.endsWith(':before')) beforeSourceCommit()
    })
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
      const invalidTarget = {
        ...intent,
        key: 'unselected-effect',
        target: { ...selected.binding, providerId: 'unselected-provider' },
      }
      const invalidSchema = {
        ...intent,
        key: 'wrong-input-schema',
        input: { ...input, schema: operation.outputSchema },
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
          actions: [
            { ...intent, intentFingerprint: fixtureHash(intent) },
            { ...invalidTarget, intentFingerprint: fixtureHash(invalidTarget) },
            { ...invalidSchema, intentFingerprint: fixtureHash(invalidSchema) },
          ],
          next: { kind: 'continue' },
        },
      })
      const actionId = stableId('act', `${fixture.draft().admission.runId}\0${intent.key}`)
      const side = fixture.db
        .prepare("SELECT identity FROM runtime_side_entries WHERE kind='action-created' AND identity=?")
        .get(actionId) as { identity: string } | undefined
      if (!side) throw Error('original action-created side absent')
      fixture.state.installEffectsActionCapture()
      expect(runtimeStateUsesDatabase(fixture.state, fixture.db)).toBe(true)
      const writesBefore = fixture.db.prepare('SELECT total_changes() AS count').get() as { count: number }
      const source = await fixture.state.captureEffectsDispatchSource(
        fixture.draft().admission.sessionId,
        side.identity,
      )
      expect(source.actionId).toBe(side.identity)
      expect(source.target).toEqual(selected)
      expect(fixture.db.prepare('SELECT total_changes() AS count').get()).toEqual(writesBefore)
      for (const version of Object.values(source.versions))
        expect(validateRuntime('RecordVersionRef', version).ok).toBe(true)
      expect(await fixture.state.verifyEffectsDispatchSource(source)).toBe(true)
      const leaseProjection = fixture.db
        .prepare('SELECT * FROM runtime_leases WHERE scope_id=?')
        .get(source.sessionId) as Record<string, unknown>
      fixture.db.prepare('UPDATE runtime_leases SET writer_id=NULL WHERE scope_id=?').run(source.sessionId)
      await expect(
        fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
      ).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      if (typeof leaseProjection.writer_id !== 'string') throw Error('original lease writer missing')
      fixture.db
        .prepare('UPDATE runtime_leases SET writer_id=? WHERE scope_id=?')
        .run(leaseProjection.writer_id, source.sessionId)
      const runHead = fixture.db
        .prepare(
          'SELECT value_json,owner_json,body_digest FROM runtime_record_heads h JOIN runtime_version_bodies b ON b.record_id=h.record_id AND b.record_revision=h.record_revision WHERE h.record_id=?',
        )
        .get(source.versions.run.recordId) as { value_json: string; owner_json: string; body_digest: string }
      const alteredRun = { ...JSON.parse(runHead.value_json), revision: source.runRevision + 1 }
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
        .run(JSON.stringify(alteredRun), source.versions.run.recordId, source.versions.run.recordRevision)
      fixture.db
        .prepare('UPDATE runtime_record_heads SET body_digest=? WHERE record_id=?')
        .run(bodyDigest(JSON.parse(runHead.owner_json), alteredRun), source.versions.run.recordId)
      await expect(
        fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
      ).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
        .run(runHead.value_json, source.versions.run.recordId, source.versions.run.recordRevision)
      fixture.db
        .prepare('UPDATE runtime_record_heads SET body_digest=? WHERE record_id=?')
        .run(runHead.body_digest, source.versions.run.recordId)
      const runProof = fixture.db
        .prepare('SELECT versions_json FROM runtime_commit_proofs WHERE commit_id=?')
        .get(source.versions.run.commitId) as { versions_json: string }
      const forgedDigest = bodyDigest(JSON.parse(runHead.owner_json), alteredRun)
      const forgedVersions = (JSON.parse(runProof.versions_json) as Array<Record<string, unknown>>).map(
        (version) =>
          version.recordId === source.versions.run.recordId ? { ...version, digest: forgedDigest } : version,
      )
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
        .run(JSON.stringify(alteredRun), source.versions.run.recordId, source.versions.run.recordRevision)
      fixture.db
        .prepare('UPDATE runtime_record_heads SET body_digest=? WHERE record_id=?')
        .run(forgedDigest, source.versions.run.recordId)
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(JSON.stringify(forgedVersions), source.versions.run.commitId)
      await expect(
        fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
      ).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(runProof.versions_json, source.versions.run.commitId)
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?')
        .run(runHead.value_json, source.versions.run.recordId, source.versions.run.recordRevision)
      fixture.db
        .prepare('UPDATE runtime_record_heads SET body_digest=? WHERE record_id=?')
        .run(runHead.body_digest, source.versions.run.recordId)
      const bindingVersionForFence = (
        fixture.db
          .prepare('SELECT versions_json FROM runtime_commit_proofs WHERE commit_id=?')
          .get(source.versions.binding.commitId) as { versions_json: string }
      ).versions_json
      beforeSourceCommit = () => {
        fixture.db
          .prepare("UPDATE runtime_commit_proofs SET versions_json='[]' WHERE commit_id=?")
          .run(source.versions.binding.commitId)
        beforeSourceCommit = () => {}
      }
      await expect(
        fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
      ).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(bindingVersionForFence, source.versions.binding.commitId)
      let clockReads = 0
      clockHook = () => {
        clockReads++
      }
      expect(await fixture.state.verifyEffectsDispatchSource(source)).toBe(true)
      const verificationClockReads = clockReads
      expect(verificationClockReads).toBeGreaterThan(1)
      clockReads = 0
      clockHook = () => {
        if (++clockReads === verificationClockReads)
          fixture.db
            .prepare("UPDATE runtime_commit_proofs SET versions_json='[]' WHERE commit_id=?")
            .run(source.versions.binding.commitId)
      }
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      expect(clockReads).toBe(verificationClockReads)
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(bindingVersionForFence, source.versions.binding.commitId)
      clockHook = () => {}
      clockReads = 0
      clockHook = () => {
        clockReads++
      }
      await fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId)
      const captureClockReads = clockReads
      expect(captureClockReads).toBeGreaterThan(1)
      clockReads = 0
      clockHook = () => {
        if (++clockReads === captureClockReads)
          fixture.db
            .prepare("UPDATE runtime_commit_proofs SET versions_json='[]' WHERE commit_id=?")
            .run(source.versions.binding.commitId)
      }
      await expect(
        fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
      ).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
      expect(clockReads).toBe(captureClockReads)
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(bindingVersionForFence, source.versions.binding.commitId)
      clockHook = () => {}
      // The compatibility views write through to the native proof rows.
      // A mutation in the final clock must not escape the native-only fence.
      const viewMutations = [
        () =>
          fixture.db
            .prepare(
              'DELETE FROM runtime_record_versions WHERE record_id=? AND record_revision=? AND commit_id=?',
            )
            .run(
              source.versions.binding.recordId,
              source.versions.binding.recordRevision,
              source.versions.binding.commitId,
            ),
        () =>
          fixture.db
            .prepare(
              "DELETE FROM runtime_side_entries WHERE commit_id=? AND kind='action-created' AND identity=?",
            )
            .run(source.createdByCommitId, source.actionId),
      ]
      for (const mutate of viewMutations) {
        for (const operation of [
          () => fixture.state.captureEffectsDispatchSource(source.sessionId, source.actionId),
          () => fixture.state.verifyEffectsDispatchSource(source),
        ]) {
          clockReads = 0
          clockHook = () => {
            clockReads++
          }
          await operation()
          const finalClock = clockReads
          clockReads = 0
          clockHook = () => {
            if (++clockReads === finalClock) mutate()
          }
          await expect(operation()).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
          expect(clockReads).toBe(finalClock)
          clockHook = () => {}
          // The rejected read transaction also rolls back the injected mutation.
          expect(await fixture.state.verifyEffectsDispatchSource(source)).toBe(true)
        }
      }
      beforeSourceCommit = () => {
        fixture.db
          .prepare("UPDATE runtime_commit_proofs SET versions_json='[]' WHERE commit_id=?")
          .run(source.versions.binding.commitId)
        beforeSourceCommit = () => {}
      }
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(bindingVersionForFence, source.versions.binding.commitId)
      const originalManifest = (
        fixture.db
          .prepare('SELECT manifests_json FROM runtime_commit_proofs WHERE commit_id=?')
          .get(source.versions.run.commitId) as { manifests_json: string }
      ).manifests_json
      beforeSourceCommit = () => {
        fixture.db
          .prepare("UPDATE runtime_commit_proofs SET manifests_json='[]' WHERE commit_id=?")
          .run(source.versions.run.commitId)
        beforeSourceCommit = () => {}
      }
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET manifests_json=? WHERE commit_id=?')
        .run(originalManifest, source.versions.run.commitId)
      expect(await fixture.state.verifyEffectsDispatchSource(structuredClone(source))).toBe(false)
      const foreign = new RuntimeStateDatabase({
        file: join(directory, 'joint.sqlite'),
        authority: fixture.binding.stateAuthorityAtCreation,
        now: () => Date.parse(fixture.draft().admission.admittedAt),
      })
      try {
        foreign.installEffectsActionCapture()
        expect(runtimeStateUsesDatabase(foreign, fixture.db)).toBe(false)
        expect(await foreign.verifyEffectsDispatchSource(source)).toBe(false)
      } finally {
        foreign.close()
      }
      const unselectedId = stableId('act', `${fixture.draft().admission.runId}\0${invalidTarget.key}`)
      await expect(
        fixture.state.captureEffectsDispatchSource(fixture.draft().admission.sessionId, unselectedId),
      ).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
      const wrongSchemaId = stableId('act', `${fixture.draft().admission.runId}\0${invalidSchema.key}`)
      await expect(
        fixture.state.captureEffectsDispatchSource(fixture.draft().admission.sessionId, wrongSchemaId),
      ).rejects.toMatchObject({ failure: { detailCode: 'integrity' } })
      fixture.db
        .prepare('UPDATE runtime_leases SET lease_until=? WHERE scope_id=?')
        .run(Date.parse(fixture.draft().admission.admittedAt) - 1, fixture.draft().admission.sessionId)
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_leases SET lease_until=? WHERE scope_id=?')
        .run(source.writer.leaseUntil, fixture.draft().admission.sessionId)
      const originalSide = fixture.db
        .prepare('SELECT sides_json FROM runtime_commit_proofs WHERE commit_id=?')
        .get(source.createdByCommitId) as { sides_json: string }
      fixture.db
        .prepare("UPDATE runtime_commit_proofs SET sides_json='[]' WHERE commit_id=?")
        .run(source.createdByCommitId)
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET sides_json=? WHERE commit_id=?')
        .run(originalSide.sides_json, source.createdByCommitId)
      const bindingVersion = fixture.db
        .prepare('SELECT versions_json FROM runtime_commit_proofs WHERE commit_id=?')
        .get(source.versions.binding.commitId) as { versions_json: string }
      fixture.db
        .prepare("UPDATE runtime_commit_proofs SET versions_json='[]' WHERE commit_id=?")
        .run(source.versions.binding.commitId)
      await expect(fixture.state.verifyEffectsDispatchSource(source)).rejects.toMatchObject({
        failure: { detailCode: 'integrity' },
      })
      fixture.db
        .prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?')
        .run(bindingVersion.versions_json, source.versions.binding.commitId)
      fixture.state.close()
      expect(await fixture.state.verifyEffectsDispatchSource(source)).toBe(false)
    } finally {
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

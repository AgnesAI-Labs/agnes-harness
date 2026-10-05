import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { admissionFixtureInput } from '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { inlineData } from '../../src/runtime/maintenance/authority-publication.js'
import { createBootstrapAnchor } from '../../src/runtime/maintenance/bootstrap-locator.js'
import { createNativeStateReadOwner } from '../../src/runtime/state/native-read-owner.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'

async function originalNativeFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-native-state-read-')))
  const input = admissionFixtureInput()
  const deploymentDirectory = join(directory, 'deployment')
  const anchor = createBootstrapAnchor(deploymentDirectory, {
    principalRef: 'not-an-authentication-proof',
    locator: {
      directoryId: 'directory',
      providerLockRef: inlineData({ locator: true }, 'agh.maintenance/provider-lock@1'),
      endpointRef: deploymentDirectory,
      epoch: 1,
      revision: 1,
      cutoverId: 'cutover',
    },
  })
  if (!anchor.ok) throw Error(anchor.error.detailCode)
  const file = join(deploymentDirectory, 'joint.sqlite')
  closeSync(createPrivateFileSync(file))
  const setupDatabase = new DatabaseSync(file)
  const authority = { authorityId: 'fixture-state', tenantId: 'fixture-tenant', authorityEpoch: 1 }
  const scope = {
    kind: 'runtime' as const,
    installationId: 'fixture-installation',
    runtimeId: 'fixture-runtime',
  }
  const now = () => Date.parse(input.fixture.now)
  const setupIdentity = createLocalDeploymentIdentity({
    database: setupDatabase,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database: setupDatabase, deploymentDirectory }),
    authority,
    scope,
    now,
  })
  setupIdentity.close()
  setupDatabase.close()
  const fixture = await openJointAdmission(deploymentDirectory, input)
  const identity = createLocalDeploymentIdentity({
    database: fixture.db,
    deploymentDirectory,
    owner: captureLocalDeploymentOwner({ database: fixture.db, deploymentDirectory }),
    authority,
    scope,
    now,
  })
  const connection = await identity.connect(new AbortController().signal)
  const context = connection.issue('2030-01-01T00:00:00Z', 'native-read')
  const reader = createNativeStateReadOwner({
    originalState: fixture.state,
    originalIdentity: identity,
    originalDatabase: fixture.db,
  })
  return {
    directory,
    deploymentDirectory,
    file,
    input,
    fixture,
    identity,
    context,
    reader,
    authority,
    scope,
    now,
  }
}

describe.skipIf(typeof process.getuid !== 'function')('original State native read snapshot', () => {
  it('reads committed Run and Binding from the original connection and rejects copies and damaged history', async () => {
    const { directory, file, input, fixture, identity, context, reader, authority } =
      await originalNativeFixture()
    try {
      expect(await fixture.coordinator.coordinate(fixture.draft(), fixture.context())).toMatchObject({
        ok: true,
        value: { state: 'created' },
      })
      const before = fixture.db.prepare('SELECT total_changes() n').get()?.n
      const snapshot = await reader.openVerifiedSnapshot('fixture-session', context)
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 1,
      }
      const first = await reader.scanVerifiedPage(snapshot, request, context)
      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      const second = await reader.scanVerifiedPage(
        snapshot,
        { ...request, cursor: first.nextCursor },
        context,
      )
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(new Set([...first.items, ...second.items].map((item) => item.schema.typeId))).toEqual(
        new Set(['agh.runtime/run-record@1', 'agh.runtime/run-binding@1']),
      )
      expect(fixture.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
      const advanced = await fixture.state.open({
        requestId: 'native-read-next-commit',
        authority,
        sessionId: 'fixture-session',
        mode: 'write',
        writerId: 'native-read-writer',
        ttlMs: 10_000,
      })
      expect(advanced.snapshot.throughSeq).toBeGreaterThan(snapshot.throughSeq)
      const historical = await reader.scanVerifiedPage(snapshot, { ...request, limit: 500 }, context)
      expect(historical.items.map((item) => item.recordId)).toEqual([
        first.items[0].recordId,
        second.items[0].recordId,
      ])
      await expect(reader.scanVerifiedPage({ ...snapshot }, request, context)).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, snapshot: { ...snapshot } }, context),
      ).rejects.toThrow()
      await expect(reader.scanVerifiedPage(snapshot, request, { ...context })).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, cursor: 'invented' }, context),
      ).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, filter: { runId: 'fixture-run-old' } }, context),
      ).rejects.toThrow()
      await expect(
        reader.scanVerifiedPage(snapshot, { ...request, collection: 'record-versions' }, context),
      ).rejects.toThrow()
      await expect(reader.scanVerifiedPage(snapshot, { ...request, limit: 501 }, context)).rejects.toThrow()
      const foreign = new DatabaseSync(file)
      try {
        expect(() =>
          createNativeStateReadOwner({
            originalState: fixture.state,
            originalIdentity: identity,
            originalDatabase: foreign,
          }),
        ).toThrow()
      } finally {
        foreign.close()
      }
      const original = fixture.db
        .prepare('SELECT value_json FROM runtime_version_bodies WHERE record_id=?')
        .get(first.items[0].recordId)?.value_json
      if (typeof original !== 'string') throw Error('original history missing')
      fixture.db
        .prepare("UPDATE runtime_version_bodies SET value_json='{}' WHERE record_id=?")
        .run(first.items[0].recordId)
      await expect(reader.scanVerifiedPage(snapshot, request, context)).rejects.toThrow()
      fixture.db
        .prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=?')
        .run(original, first.items[0].recordId)
      expect((await reader.scanVerifiedPage(snapshot, request, context)).items).toHaveLength(1)
      input.fixture.now = '2026-10-03T00:02:00Z'
      await expect(reader.scanVerifiedPage(snapshot, request, context)).rejects.toThrow()
      const fresh = await reader.openVerifiedSnapshot('fixture-session', context)
      identity.revoke()
      await expect(reader.scanVerifiedPage(fresh, { ...request, snapshot: fresh }, context)).rejects.toThrow()
    } finally {
      reader.close()
      identity.close()
      await fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('reopens persisted original State and local identity while refusing an old process snapshot', async () => {
    const first = await originalNativeFixture()
    let reopened: Awaited<ReturnType<typeof openJointAdmission>> | undefined
    let identity: ReturnType<typeof createLocalDeploymentIdentity> | undefined
    let reader: ReturnType<typeof createNativeStateReadOwner> | undefined
    try {
      expect(
        await first.fixture.coordinator.coordinate(first.fixture.draft(), first.fixture.context()),
      ).toMatchObject({
        ok: true,
        value: { state: 'created' },
      })
      const snapshot = await first.reader.openVerifiedSnapshot('fixture-session', first.context)
      first.reader.close()
      first.identity.close()
      await first.fixture.close()
      reopened = await openJointAdmission(first.deploymentDirectory, first.input)
      identity = createLocalDeploymentIdentity({
        database: reopened.db,
        deploymentDirectory: first.deploymentDirectory,
        owner: captureLocalDeploymentOwner({
          database: reopened.db,
          deploymentDirectory: first.deploymentDirectory,
        }),
        authority: first.authority,
        scope: first.scope,
        now: first.now,
      })
      const connection = await identity.connect(new AbortController().signal)
      const context = connection.issue('2030-01-01T00:00:00Z', 'cold-native-read')
      reader = createNativeStateReadOwner({
        originalState: reopened.state,
        originalIdentity: identity,
        originalDatabase: reopened.db,
      })
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 500,
      }
      await expect(reader.scanVerifiedPage(snapshot, request, context)).rejects.toThrow()
      const fresh = await reader.openVerifiedSnapshot('fixture-session', context)
      const freshItems = (await reader.scanVerifiedPage(fresh, { ...request, snapshot: fresh }, context))
        .items
      expect(freshItems).toHaveLength(2)
      reader.close()
      identity.close()
      await reopened.close()
      const script = fileURLToPath(new URL('./fixtures/native-state-read-process.ts', import.meta.url))
      const child = spawnSync(process.execPath, ['--import', 'tsx', script, first.deploymentDirectory], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual(freshItems.map((item) => [item.recordId, item.digest]))
      reader = undefined
      identity = undefined
      reopened = undefined
    } finally {
      reader?.close()
      identity?.close()
      await reopened?.close()
      rmSync(first.directory, { recursive: true, force: true })
    }
  }, 30_000)
})

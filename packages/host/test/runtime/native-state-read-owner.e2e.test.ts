import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLocalDeploymentIdentity } from '../../src/runtime/identity/local-deployment-identity.js'
import { captureLocalDeploymentOwner } from '../../src/runtime/identity/local-deployment-owner.js'
import { createNativeStateReadOwner } from '../../src/runtime/state/native-read-owner.js'
import { openJointAdmission } from './fixtures/assembly-admission-joint.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { localTestBridge } from './fixtures/state-query-fixture.js'

describe.skipIf(typeof process.getuid !== 'function')('original State native read in a fresh process', () => {
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
      const snapshot = await first.reader.openVerifiedSnapshot('fixture-session', first.grant)
      await first.reader.close()
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
      reader = createNativeStateReadOwner({ originalState: reopened.state, runtimeScope: first.scope })
      const grant = localTestBridge({
        context,
        identity,
        scope: first.scope,
        database: reopened.db,
      }).bridge.grant(context, 'fixture-session')
      if (!grant) throw Error('test bridge refused the fixture session')
      const request = {
        snapshot,
        collection: 'records' as const,
        filter: {},
        order: 'asc' as const,
        cursor: null,
        limit: 500,
      }
      await expect(reader.scanVerifiedPage(snapshot, request, grant)).rejects.toThrow()
      const fresh = await reader.openVerifiedSnapshot('fixture-session', grant)
      const freshItems = (await reader.scanVerifiedPage(fresh, { ...request, snapshot: fresh }, grant)).items
      expect(freshItems).toHaveLength(2)
      await reader.close()
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
      await reader?.close()
      identity?.close()
      await reopened?.close()
      rmSync(first.directory, { recursive: true, force: true })
    }
  }, 30_000)
})

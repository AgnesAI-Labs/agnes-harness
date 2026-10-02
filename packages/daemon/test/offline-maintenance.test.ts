import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectoryAnchor, openBootstrapAnchor } from '@agnes/host'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  acquireDaemonOfflineMaintenance,
  readOfflineMaintenanceLocator,
} from '../src/supervisor/offline-maintenance.js'

it('diagnoses a missing business tree from the external anchor and refuses an uncertain maintenance epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'authority-offline-'))
  const anchor = join(root, 'anchor')
  const scope = { dataDir: join(root, 'data') }
  const digest = canonicalJsonDigest({})
  const locator = {
    directoryId: 'directory-1',
    providerLockRef: {
      kind: 'inline' as const,
      schema: { typeId: 'agh.maintenance/provider-lock@1', revision: 1, digest },
      value: {},
      digest,
      bytes: 2,
    },
    endpointRef: join(root, 'missing-business-tree'),
    epoch: 1,
    revision: 1,
    cutoverId: 'initial',
  }
  try {
    expect(createDirectoryAnchor(anchor, locator, 'maintainer').ok).toBe(true)
    expect(readOfflineMaintenanceLocator(anchor).locator).toEqual(locator)
    const held = acquireDaemonOfflineMaintenance(scope, { anchor, expectedEpoch: 1 })
    held.release()
    held.release()
    const opened = openBootstrapAnchor(anchor)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.value.compareAndSwap(1, { ...locator, epoch: 2, revision: 2, cutoverId: 'move' }).ok).toBe(
      true,
    )
    expect(() => acquireDaemonOfflineMaintenance(scope, { anchor, expectedEpoch: 1 })).toThrow(
      'epoch is uncertain',
    )
    const next = acquireDaemonOfflineMaintenance(scope, { anchor, expectedEpoch: 2 })
    next.release()
    writeFileSync(join(anchor, 'locator.json'), '{broken')
    expect(() => readOfflineMaintenanceLocator(anchor)).toThrow('anchor_corrupt')
    expect(() => acquireDaemonOfflineMaintenance(scope, { anchor, expectedEpoch: 2 })).toThrow(
      'anchor_corrupt',
    )
    const legacy = acquireDaemonOfflineMaintenance(scope)
    legacy.release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

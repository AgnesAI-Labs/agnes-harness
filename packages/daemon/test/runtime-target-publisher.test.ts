import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { publishProbedRuntimeTarget } from '../src/runtime-target-publisher.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'd'.repeat(64)

function artifact(id: string) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id,
          plugin: `builtin:host/${id}`,
          snapshotDigest: 'builtin:host:v1',
          exportName: id,
          entryRevision: 'host-row:v1',
          extrasRevision: 'none',
          mountRevision: 'host-row:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

describe('publishProbedRuntimeTarget', () => {
  it('persists the probed artifact without rebuilding it', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const value = artifact('ext:live')
    const probe = vi.fn(async (probed: typeof value) => {
      expect(probed.digest).toBe(value.digest)
      expect(probed.canonicalBase64).toBe(value.canonicalBase64)
    })
    await publishProbedRuntimeTarget({
      store,
      artifact: value,
      pins: ['tree:live'],
      probe,
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(store.desired()).toEqual(value)
    expect(store.pins()).toEqual([])
  })

  it('does not publish when probe fails', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    await expect(
      publishProbedRuntimeTarget({
        store,
        artifact: artifact('ext:fail'),
        probe: async () => {
          throw new Error('probe failed')
        },
      }),
    ).rejects.toThrow('probe failed')
    expect(store.desired()).toBeUndefined()
  })

  it('keeps one probed artifact and no ack without lastGood/report after a qualify crash', async () => {
    const tables = sqliteTables()
    const handle = tables.table('composite')
    const store = new CompositeTargetStore(handle, 'default')
    const value = artifact('ext:live')
    await publishProbedRuntimeTarget({
      store,
      artifact: value,
      probe: async (probed) => {
        expect(probed).toEqual(value)
      },
    })
    expect(store.desired()).toEqual(value)
    const exec = handle.exec.bind(handle)
    handle.exec = (sql, params = []) => {
      exec(sql, params)
      if (String(sql).includes('acknowledged_json')) throw new Error('injected crash after live failure')
    }
    expect(() =>
      store.qualifyConverged(1, value, { hash: value.identity.treeHash, ok: true, rows: [] }),
    ).toThrow('injected crash after live failure')
    expect(store.desired()).toEqual(value)
    expect(store.acknowledged()).toBeUndefined()
    expect(store.lastGood()).toBeUndefined()
    expect(store.report()).toBeUndefined()
  })
})

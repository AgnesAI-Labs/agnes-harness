import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { pluginTreeActual, pluginTreeList } from '../src/plugin-tree-surface.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'f'.repeat(64)

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

describe('plugin tree surface', () => {
  it('treats actual as qualified report.ok for current desired digest/identity and generation', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const desired = artifact('ext:live')
    store.publishDesired(desired)
    const notice = pluginTreeList(store, 'default', 1).notice
    expect(notice?.targetDigest).toBe(desired.digest)
    expect(notice?.hash).toBe(desired.digest)
    expect(pluginTreeActual(store, 1)?.actual).toBe(false)
    expect(pluginTreeActual(store, 1)?.pending).toBe(true)
    store.qualifyConverged(3, desired, { hash: desired.identity.treeHash, ok: true, rows: [] })
    expect(pluginTreeActual(store, 3)?.actual).toBe(true)
    expect(pluginTreeActual(store, 4)?.actual).toBe(false)
    expect(pluginTreeActual(store, undefined)?.actual).toBe(false)
    const previous = artifact('ext:old')
    store.publishDesired(previous)
    store.publishDesired(desired)
    // Rollback goes through the RPC handler and its probed publisher (plugin-tree-rpc.test.ts);
    // here we only pin the store semantics the handler relies on.
    expect(store.previous()?.digest).toBe(previous.digest)
  })

  it('reports desired vs actual by poll when a tree_changed notice is dropped', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const desired = artifact('ext:live')
    store.publishDesired(desired)
    const polled = pluginTreeList(store, 'default', 1)
    expect(polled.notice?.targetDigest).toBe(desired.digest)
    expect(polled.actual?.actual).toBe(false)
    expect(polled.actual?.pending).toBe(true)
    store.qualifyConverged(2, desired, { hash: desired.identity.treeHash, ok: true, rows: [] })
    expect(pluginTreeList(store, 'default', 2).actual?.actual).toBe(true)
  })

  it('keeps resource-only updates pending and does not treat failurePhase as actual', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const tree = artifact('ext:live')
    store.publishDesired(tree)
    store.qualifyConverged(1, tree, { hash: tree.identity.treeHash, ok: true, rows: [] })
    expect(pluginTreeActual(store, 1)?.actual).toBe(true)
    const resourceOnly = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: [
          createPluginRow({
            id: 'ext:live',
            plugin: 'builtin:host/ext:live',
            snapshotDigest: 'builtin:host:v1',
            exportName: 'ext:live',
            entryRevision: 'host-row:v1',
            extrasRevision: 'none',
            mountRevision: 'host-row:v1',
          }),
        ],
        resources: { mcp: [{ id: 'mcp-b' }], skills: {} },
        resourceRevision: '1'.repeat(64),
        compositeRevision: '2'.repeat(64),
      }),
    )
    store.publishDesired(resourceOnly)
    expect(pluginTreeActual(store, 1)?.actual).toBe(false)
    expect(pluginTreeActual(store, 1)?.pending).toBe(true)
    store.qualifyFailed(1, resourceOnly, {
      generation: 1,
      digest: resourceOnly.digest,
      identity: resourceOnly.identity,
      phase: 'health',
      message: 'resource unhealthy',
    })
    expect(pluginTreeActual(store, 1)?.actual).toBe(false)
    expect(pluginTreeActual(store, 1)?.failurePhase).toBe('health')
  })
})

import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'c'.repeat(64)

function artifact(id: string, config?: Record<string, string>) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id,
          ...(config ? { config } : {}),
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

function packageArtifact(snapshot: string) {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [
        createPluginRow({
          id: 'ext:package-owned',
          plugin: `acme/pkg-a@${snapshot}/main`,
          snapshotDigest: snapshot,
          exportName: 'main',
          entryRevision: snapshot,
          extrasRevision: 'none',
          mountRevision: 'host-ordinary-row:v1',
        }),
      ],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

describe('CompositeTargetStore', () => {
  it('atomically publishes desired/previous and treats unmatched digest as pending', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const first = artifact('ext:one')
    const second = artifact('ext:two')
    store.publishDesired(first)
    expect(store.desired()?.digest).toBe(first.digest)
    const target = store.target(store.desired()!)
    expect(Object.isFrozen(target.tree.rows)).toBe(true)
    expect(() => (target.tree.rows as unknown[]).push({})).toThrow()
    const handle = tables.table('composite')
    handle.exec('UPDATE composite_targets SET desired_json = ? WHERE profile = ?', [
      JSON.stringify({ ...first, canonicalBase64: second.canonicalBase64 }),
      'default',
    ])
    expect(() => store.desired()).toThrow()
    handle.exec('UPDATE composite_targets SET desired_json = ? WHERE profile = ?', [
      JSON.stringify(first),
      'default',
    ])
    expect(store.desired()?.digest).toBe(first.digest)
    expect(store.pending()).toBe(true)
    store.publishDesired(second)
    expect(store.desired()?.digest).toBe(second.digest)
    expect(store.previous()?.digest).toBe(first.digest)
    expect(store.acknowledged()).toBeUndefined()
  })

  it('creates no overlay or command tables', async () => {
    const tables = sqliteTables()
    new CompositeTargetStore(tables.table('composite'), 'default')
    const names = tables
      .table('composite')
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'composite_target%' ORDER BY name",
      )
      .map((row) => row.name)
    expect(names).toEqual([
      'composite_target_package_failures',
      'composite_target_pins',
      'composite_target_reverts',
      'composite_targets',
    ])
    await tables.close()
  })

  it('reports current, rollback and disabled saved configurations across profiles for credential integrity', async () => {
    const tables = sqliteTables()
    const first = new CompositeTargetStore(tables.table('composite'), 'first')
    const second = new CompositeTargetStore(tables.table('composite'), 'second')
    const ref = 'secret://generic/11111111-1111-4111-8111-111111111111'
    first.publishDesired(artifact('ext:rollback', { credential: ref }))
    first.publishDesired(
      artifact('ext:current', { credential: 'secret://generic/22222222-2222-4222-8222-222222222222' }),
    )
    second.publishDesired(artifact('ext:other', { credential: ref }))
    tables
      .table('composite')
      .exec(
        'INSERT INTO plugin_config_values (profile, package_id, row_id, value_json) VALUES (?, ?, ?, ?)',
        ['first', 'package', 'ext:disabled', JSON.stringify({ credential: ref })],
      )
    expect(first.credentialConfigurations()).toEqual(
      expect.arrayContaining([
        { kind: 'plugin', profile: 'first', configId: 'ext:rollback', value: { credential: ref } },
        { kind: 'plugin', profile: 'second', configId: 'ext:other', value: { credential: ref } },
        { kind: 'plugin', profile: 'first', configId: 'ext:disabled', value: { credential: ref } },
      ]),
    )
    await tables.close()
  })

  it('qualifies converged lastGood/report/ack in one transaction and ignores stale failures', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const desired = artifact('ext:live')
    const stale = artifact('ext:old')
    store.publishDesired(desired)
    const report = { hash: desired.identity.treeHash, ok: true, rows: [{ id: 'ext:live', state: 'active' }] }
    expect(store.qualifyConverged(1, desired, report)).toBe(true)
    expect(store.lastGood()?.digest).toBe(desired.digest)
    expect(store.acknowledged()?.digest).toBe(desired.digest)
    expect(store.report()?.ok).toBe(true)
    expect(store.pending()).toBe(false)
    expect(
      store.qualifyFailed(1, stale, {
        generation: 1,
        digest: stale.digest,
        identity: stale.identity,
        phase: 'apply',
        message: 'stale',
      }),
    ).toBe(false)
    expect(store.lastFailure()).toBeUndefined()
    expect(
      store.qualifyFailed(1, desired, {
        generation: 1,
        digest: desired.digest,
        identity: desired.identity,
        phase: 'health',
        message: 'unhealthy',
      }),
    ).toBe(true)
    expect(store.lastGood()?.digest).toBe(desired.digest)
    expect(store.lastFailure()?.phase).toBe('health')
  })

  it('rolls back so ack cannot exist without lastGood and report after an injected crash', () => {
    const tables = sqliteTables()
    const handle = tables.table('composite')
    const store = new CompositeTargetStore(handle, 'default')
    const desired = artifact('ext:crash')
    store.publishDesired(desired)
    const exec = handle.exec.bind(handle)
    handle.exec = (sql, params = []) => {
      exec(sql, params)
      if (String(sql).includes('acknowledged_json')) throw new Error('injected crash after live failure')
    }
    expect(() =>
      store.qualifyConverged(1, desired, { hash: desired.identity.treeHash, ok: true, rows: [] }),
    ).toThrow('injected crash after live failure')
    expect(store.acknowledged()).toBeUndefined()
    expect(store.lastGood()).toBeUndefined()
    expect(store.report()).toBeUndefined()
  })

  it('does not let an old ack clear a newer desired digest', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const first = artifact('ext:one')
    const second = artifact('ext:two')
    store.publishDesired(first)
    expect(store.qualifyConverged(2, first, { hash: first.identity.treeHash, ok: true, rows: [] })).toBe(true)
    store.publishDesired(second)
    expect(store.pending()).toBe(true)
    expect(store.acknowledged()).toBeUndefined()
    expect(store.lastGood()?.digest).toBe(first.digest)
    expect(store.qualifyConverged(2, first, { hash: first.identity.treeHash, ok: true, rows: [] })).toBe(
      false,
    )
    expect(store.desired()?.digest).toBe(second.digest)
  })

  it('removes revoked package rows from desired, previous, and lastGood recovery targets', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    const first = packageArtifact('snapshot-one')
    const second = packageArtifact('snapshot-two')
    store.publishDesired(first)
    expect(store.qualifyConverged(1, first, { hash: first.identity.treeHash, ok: true, rows: [] })).toBe(true)
    store.publishDesired(second)

    const updates: string[] = []
    const stop = store.onDesired((next) => updates.push(next.digest))
    expect(store.revokePackage('acme/pkg-a')).toBe(true)
    stop()

    expect(store.desired()?.identity.treeHash).toBe(store.previous()?.identity.treeHash)
    expect(store.desired()?.identity.treeHash).toBe(store.lastGood()?.identity.treeHash)
    expect(store.desired()?.identity.treeHash).not.toBe(second.identity.treeHash)
    expect(store.desired()?.canonicalBase64).not.toBe(second.canonicalBase64)
    expect(store.desired()).toBeDefined()
    expect(decodeRows(store.desired())).toEqual([])
    expect(decodeRows(store.previous())).toEqual([])
    expect(decodeRows(store.lastGood())).toEqual([])
    expect(updates).toHaveLength(1)
    expect(store.pending()).toBe(true)
  })

  it('records and sweeps pins', () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), 'default')
    store.pin('tree:one')
    store.pin('resource:one')
    expect(store.pins()).toEqual(['resource:one', 'tree:one'])
    store.sweepPins()
    expect(store.pins()).toEqual([])
  })
})

function decodeRows(value: ReturnType<CompositeTargetStore['desired']>) {
  if (!value) return []
  return decodeRuntimeTargetArtifact(value).tree.rows
}

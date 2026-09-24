import {
  buildRuntimeTarget,
  createPluginRow,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { createCompositeTargetActivation } from '../src/composite-target-activation.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'b'.repeat(64)
const snap1 = `sha256-${'1'.repeat(64)}`
const snap2 = `sha256-${'2'.repeat(64)}`

function pluginRow(id: string, plugin: string, snapshotId: string) {
  return createPluginRow({
    id,
    plugin,
    snapshotDigest: snapshotId,
    exportName: 'main',
    entryRevision: snapshotId,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
  })
}

function target(rows: ReturnType<typeof pluginRow>[]): RuntimeTargetArtifact {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows,
      resources: { mcp: [], skills: {} },
      resourceRevision: revision,
      compositeRevision: revision,
    }),
  )
}

function setup(
  lastGoodArtifact: RuntimeTargetArtifact,
  nextArtifact: RuntimeTargetArtifact,
  confirmedIds: string[],
) {
  const store = new CompositeTargetStore(sqliteTables().table('composite'), 'default')
  store.publishDesired(lastGoodArtifact)
  store.qualifyConverged(1, lastGoodArtifact, {
    hash: lastGoodArtifact.identity.treeHash,
    ok: true,
    rows: confirmedIds.map((id) => ({ id, state: 'active' })),
  })
  const activation = createCompositeTargetActivation({
    store,
    workerGeneration: () => 1,
    contributions: () => [],
    probe: async () => {},
    desiredFor: async () => nextArtifact,
    deliver: async () => {},
  })
  return { store, activation }
}

async function reconcile(activation: ReturnType<typeof setup>['activation'], packageId: string) {
  await activation.reconcile({
    profile: 'default',
    packageId,
    operationId: 'op',
    operation: 'enable',
    signal: new AbortController().signal,
  })
}

describe('composite-target-activation: dropUnpinnedLastGood plugin-id parsing', () => {
  it('keeps lastGood when a multi-client package snapshot is unchanged (regression)', async () => {
    // pkg-a: one ext: row plus two client-exposed contributions -> "pkg-a@snap1/client/c1" and
    // "pkg-a@snap1/client/c2" -- the multi-slash shape composite-desired.ts's rowsForPackage emits for
    // >=2 client contributions (composite-desired.ts:136-140).
    const lastGood = target([
      pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1),
      pluginRow('web:pkg-a:c1', `pkg-a@${snap1}/client/c1`, snap1),
      pluginRow('web:pkg-a:c2', `pkg-a@${snap1}/client/c2`, snap1),
    ])
    // Same real snapshot (snap1) still loads pkg-a's ext: row; only the client row shape differs
    // (collapsed to the single-client "pkg-a@snap1/client" form).
    const next = target([
      pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1),
      pluginRow('web:pkg-a', `pkg-a@${snap1}/client`, snap1),
    ])
    const { store, activation } = setup(lastGood, next, ['ext:pkg-a/exportA', 'web:pkg-a:c1', 'web:pkg-a:c2'])
    expect(store.lastGood()).toBeDefined()

    await reconcile(activation, 'pkg-a')

    expect(store.lastGood()).toBeDefined()
  })

  it('keeps lastGood for an unchanged single-client id shape (preservation)', async () => {
    const lastGood = target([
      pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1),
      pluginRow('web:pkg-a', `pkg-a@${snap1}/client`, snap1),
    ])
    const next = target([
      pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1),
      pluginRow('web:pkg-a', `pkg-a@${snap1}/client`, snap1),
    ])
    const { store, activation } = setup(lastGood, next, ['ext:pkg-a/exportA', 'web:pkg-a'])
    expect(store.lastGood()).toBeDefined()

    await reconcile(activation, 'pkg-a')

    expect(store.lastGood()).toBeDefined()
  })

  it('keeps lastGood for an unchanged scoped-package id shape (preservation)', async () => {
    const lastGood = target([
      pluginRow('ext:scope-pkg/exportA', `@scope/pkg@${snap1}/exportA`, snap1),
      pluginRow('web:scope-pkg:c1', `@scope/pkg@${snap1}/client/c1`, snap1),
      pluginRow('web:scope-pkg:c2', `@scope/pkg@${snap1}/client/c2`, snap1),
    ])
    const next = target([
      pluginRow('ext:scope-pkg/exportA', `@scope/pkg@${snap1}/exportA`, snap1),
      pluginRow('web:scope-pkg:c1', `@scope/pkg@${snap1}/client/c1`, snap1),
      pluginRow('web:scope-pkg:c2', `@scope/pkg@${snap1}/client/c2`, snap1),
    ])
    const { store, activation } = setup(lastGood, next, [
      'ext:scope-pkg/exportA',
      'web:scope-pkg:c1',
      'web:scope-pkg:c2',
    ])
    expect(store.lastGood()).toBeDefined()

    await reconcile(activation, '@scope/pkg')

    expect(store.lastGood()).toBeDefined()
  })

  it('drops lastGood when the package snapshot was really replaced (preservation)', async () => {
    const lastGood = target([pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1)])
    const next = target([pluginRow('ext:pkg-a/exportA', `pkg-a@${snap2}/exportA`, snap2)])
    const { store, activation } = setup(lastGood, next, ['ext:pkg-a/exportA'])
    expect(store.lastGood()).toBeDefined()

    await reconcile(activation, 'pkg-a')

    expect(store.lastGood()).toBeUndefined()
  })

  it('drops lastGood when the package was removed from next (preservation)', async () => {
    const lastGood = target([pluginRow('ext:pkg-a/exportA', `pkg-a@${snap1}/exportA`, snap1)])
    const next = target([])
    const { store, activation } = setup(lastGood, next, ['ext:pkg-a/exportA'])
    expect(store.lastGood()).toBeDefined()

    await reconcile(activation, 'pkg-a')

    expect(store.lastGood()).toBeUndefined()
  })
})

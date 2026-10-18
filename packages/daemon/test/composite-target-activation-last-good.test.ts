import {
  buildRuntimeTarget,
  createPluginRow,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { createCompositeTargetActivation } from '../src/supervisor/publication/composite-target-activation.js'

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

it('probes and publishes one reviewed target for a parent and its dependent', async () => {
  const store = new CompositeTargetStore(sqliteTables().table('joint-update'), 'default')
  const before = target([
    pluginRow('ext:parent/main', `parent@${snap1}/main`, snap1),
    pluginRow('ext:example/main', `example@${snap1}/main`, snap1),
  ])
  const next = target([
    pluginRow('ext:parent/main', `parent@${snap2}/main`, snap2),
    pluginRow('ext:example/main', `example@${snap2}/main`, snap2),
  ])
  store.publishDesired(before)
  let delivered: RuntimeTargetArtifact | undefined
  const activation = createCompositeTargetActivation({
    store,
    desiredFor: async (input) => {
      expect(input).toMatchObject({ packageId: 'parent', packageIds: ['example'], operation: 'update' })
      return next
    },
    probe: async (artifact) => {
      expect(artifact.digest).toBe(next.digest)
    },
    deliver: async (artifact) => {
      delivered = artifact
    },
  })
  await activation.reconcile({
    profile: 'default',
    packageId: 'parent',
    packageIds: ['example'],
    operation: 'update',
    operationId: 'reviewed-joint-update',
    signal: new AbortController().signal,
  })
  expect(store.desired()?.digest).toBe(next.digest)
  expect(delivered?.digest).toBe(next.digest)
})

it.each(['extension-only', 'mixed', 'surface-only', 'client-only', 'static-skills'] as const)(
  'observes dormant backend runtime without suppressing independent %s readiness',
  async (kind) => {
    const backend = kind === 'extension-only' || kind === 'mixed'
    let generation: number | undefined
    let eligible = true
    const artifact = target(backend ? [pluginRow('ext:pkg/main', `pkg@${snap1}/main`, snap1)] : [])
    const store = new CompositeTargetStore(sqliteTables().table('dormant'), 'default')
    store.publishDesired(artifact)
    const activation = createCompositeTargetActivation({
      store,
      workerGeneration: () => generation,
      workerStarting: () => false,
      contributions: () =>
        kind === 'static-skills'
          ? [{ kind: 'skill' }]
          : kind === 'client-only'
            ? [{ kind: 'extension', client: {}, capabilities: { ui: true } }]
            : kind === 'extension-only'
              ? []
              : [{ kind: 'surface' }],
      surfaceRunningRevision: () => 'surface',
      desiredSurfaceRevision: () => 'surface',
      clientRosterMatch: () => true,
      lifecycleEligible: () => eligible,
      packageIdentity: () => ({ integrity: snap1 }),
      probe: async () => {},
      deliver: async () => {},
    })
    expect(await activation.actual?.('default', 'pkg')).toMatchObject({
      actual: backend || kind === 'static-skills' ? 'not-running' : 'running',
    })
    if (kind === 'static-skills') {
      generation = 1
      store.qualifyConverged(1, artifact, { hash: artifact.identity.treeHash, ok: true, rows: [] })
      expect(await activation.actual?.('default', 'pkg')).toMatchObject({
        actual: 'running',
        actualIntegrity: snap1,
      })
      eligible = false
      expect(await activation.actual?.('default', 'pkg')).toMatchObject({ actual: 'not-running' })
      eligible = true
      store.publishDesired(target([pluginRow('other', 'builtin:host/other', 'builtin:host:v1')]))
      expect(await activation.actual?.('default', 'pkg')).not.toMatchObject({ actual: 'running' })
    }
    if (backend) {
      // A non-settling write keeps its existing pending result after delivery; only reads
      // distinguish a dormant worker. Settling/reconcile ownership remains unchanged.
      expect(
        await activation.reconcile({
          profile: 'default',
          packageId: 'pkg',
          operation: 'enable',
          operationId: 'op',
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ actual: 'starting' })
    }
  },
)

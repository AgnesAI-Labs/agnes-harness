import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackageManager } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCompositeReferenceFacts,
  createCompositeTargetActivation,
} from '../src/composite-target-activation.js'
import { createPackageAdminService } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'
import { CompositeTargetStore } from '../src/storage/composite-target-store.js'
import { sqliteTables } from './sqlite-tables.js'

const revision = 'c'.repeat(64)
const profile = 'local-dev'
const authority = {
  audience: 'admin' as const,
  principalId: 'unix:test',
  clientId: 'admin-web',
  permissions: ['packages.read', 'packages.activate'] as const,
}

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

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function service(store: CompositeTargetStore, nextDesired?: ReturnType<typeof artifact>) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-tree-rpc-'))
  roots.push(root)
  return createPackageAdminService({
    manager: {} as PackageManager,
    profileDirectory: async () => root,
    operations: new FilePackageOperationStore(join(root, 'ops')),
    pluginTree: store,
    pluginTreePublisher: async (artifact) => {
      store.publishDesired(artifact)
    },
    workerGeneration: () => 3,
    activation: createCompositeTargetActivation({
      store,
      workerGeneration: () => 3,
      probe: async () => undefined,
      ...(nextDesired ? { desiredFor: () => nextDesired } : {}),
    }),
    clock: () => '2026-09-20T00:00:00.000Z',
  })
}

describe('plugins.tree RPC', () => {
  it('get/list/apply/rollback read and write only CompositeTargetStore', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    const admin = service(store)
    const first = artifact('ext:one')
    const second = artifact('ext:two')
    expect(await admin.call('_agnes/v1/plugins.tree.list', { profile }, authority)).toMatchObject({
      actual: false,
      pending: false,
    })
    expect(
      await admin.call(
        '_agnes/v1/plugins.tree.apply',
        { profile, clientId: 'admin-web', commandId: 'cmd-apply', artifact: first },
        authority,
      ),
    ).toEqual({ desiredDigest: first.digest, pending: true })
    expect(store.desired()?.digest).toBe(first.digest)
    const listed = (await admin.call('_agnes/v1/plugins.tree.list', { profile }, authority)) as {
      pending: boolean
      actual: boolean
      desiredDigest: string
    }
    expect(listed).toMatchObject({ pending: true, actual: false, desiredDigest: first.digest })
    expect(await admin.call('_agnes/v1/plugins.tree.get', { profile }, authority)).toMatchObject({
      desired: first,
      pending: true,
    })
    await admin.call(
      '_agnes/v1/plugins.tree.apply',
      { profile, clientId: 'admin-web', commandId: 'cmd-apply-2', artifact: second },
      authority,
    )
    expect(
      await admin.call(
        '_agnes/v1/plugins.tree.rollback',
        { profile, clientId: 'admin-web', commandId: 'cmd-rollback' },
        authority,
      ),
    ).toEqual({ rolledBack: true, desiredDigest: first.digest })
    expect(store.desired()?.digest).toBe(first.digest)
    store.qualifyConverged(3, first, { hash: first.identity.treeHash, ok: true, rows: [] })
    expect(await admin.call('_agnes/v1/plugins.tree.list', { profile }, authority)).toMatchObject({
      actual: true,
      pending: false,
      desiredDigest: first.digest,
    })
  })

  it('list resolves a pluginTree getter bound after construction', async () => {
    const tables = sqliteTables()
    let store: CompositeTargetStore | undefined
    const root = mkdtempSync(join(tmpdir(), 'plugin-tree-bind-'))
    roots.push(root)
    const admin = createPackageAdminService({
      manager: {} as PackageManager,
      profileDirectory: async () => root,
      operations: new FilePackageOperationStore(join(root, 'ops')),
      pluginTree: () => store,
      workerGeneration: () => 3,
      clock: () => '2026-09-20T00:00:00.000Z',
    })
    expect(await admin.call('_agnes/v1/plugins.tree.list', { profile }, authority)).toEqual({
      actual: false,
      pending: false,
    })
    store = new CompositeTargetStore(tables.table('composite'), profile)
    const first = artifact('ext:one')
    store.publishDesired(first)
    expect(await admin.call('_agnes/v1/plugins.tree.list', { profile }, authority)).toMatchObject({
      actual: false,
      pending: true,
      desiredDigest: first.digest,
    })
  })

  it('enable/disable write CompositeTargetStore rather than in-process activation', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    const first = artifact('ext:one')
    const enabled = artifact('ext:enabled')
    store.publishDesired(first)
    const adapter = createCompositeTargetActivation({
      store,
      workerGeneration: () => 1,
      probe: async () => undefined,
      desiredFor: ({ operation }) => (operation === 'enable' ? enabled : first),
    })
    const observed = await adapter.reconcile({
      profile,
      packageId: 'acme/pkg',
      operationId: 'op-1',
      operation: 'enable',
      signal: new AbortController().signal,
    })
    expect(store.desired()?.digest).toBe(enabled.digest)
    expect(observed.actual).toBe('starting')
    const disabled = await adapter.reconcile({
      profile,
      packageId: 'acme/pkg',
      operationId: 'op-2',
      operation: 'disable',
      signal: new AbortController().signal,
    })
    expect(store.desired()?.digest).toBe(first.digest)
    expect(disabled.actual).toBe('starting')
  })

  it('fails closed on rollback when the package is no longer lifecycle-eligible', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    const previous = artifact('ext:previous')
    const desired = artifact('ext:current')
    store.publishDesired(previous)
    store.publishDesired(desired)
    const eligible = false
    let probed = false
    const adapter = createCompositeTargetActivation({
      store,
      probe: async () => {
        probed = true
      },
      lifecycleEligible: () => eligible,
    })
    const result = await adapter.reconcile({
      profile,
      packageId: 'acme/pkg',
      operationId: 'rollback-revoked',
      operation: 'rollback',
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ actual: 'failed', error: { code: 'E_PACKAGE_STATE' } })
    expect(probed).toBe(false)
    expect(store.desired()?.digest).toBe(desired.digest)
  })

  describe('the last confirmed target after a package operation', () => {
    const pkg = 'acme/pkg'
    const packageArtifact = (snapshot: string | undefined) =>
      encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows:
            snapshot === undefined
              ? []
              : [
                  createPluginRow({
                    id: `ext:${pkg}/probe`,
                    plugin: `${pkg}@${snapshot}/probe`,
                    snapshotDigest: snapshot,
                    exportName: 'probe',
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
    const run = async (
      operation: 'remove' | 'update' | 'disable',
      next: ReturnType<typeof packageArtifact>,
    ) => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const before = packageArtifact('sha256-old')
      store.publishDesired(before)
      store.qualifyConverged(1, before, { hash: before.identity.treeHash, ok: true, rows: [] } as never)
      const adapter = createCompositeTargetActivation({
        store,
        workerGeneration: () => undefined,
        probe: async () => undefined,
        desiredFor: () => next,
      })
      await adapter.reconcile({
        profile,
        packageId: pkg,
        operationId: 'op',
        operation,
        signal: new AbortController().signal,
      })
      return store.lastGood()
    }

    it('is dropped once a removal deleted the snapshot it loads, so a worker can boot again', async () => {
      expect(await run('remove', packageArtifact(undefined))).toBeUndefined()
    })

    it('is dropped once an update replaced the snapshot it loads', async () => {
      expect(await run('update', packageArtifact('sha256-new'))).toBeUndefined()
    })

    it('is kept when the snapshot it loads is still there, as after a disable', async () => {
      expect(await run('disable', packageArtifact('sha256-old'))).toBeDefined()
    })
  })

  describe('the runtime reference a package removal has to wait for', () => {
    const pkg = 'acme/pkg'
    const input = { profile, packageId: pkg, operation: 'remove' as const, extensions: [] }
    const facts = async (state: string | undefined, converged = true, worker: number | null = 1) => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const desired = artifact(`ext:${pkg}/tool`)
      store.publishDesired(desired)
      if (converged) {
        store.qualifyConverged(1, desired, {
          hash: desired.identity.treeHash,
          ok: true,
          rows: state === undefined ? [] : [{ id: `ext:${pkg}/tool`, state }],
        } as never)
      }
      return (await createCompositeReferenceFacts(store, () => worker ?? undefined)(input)).runtime.map(
        (fact) => fact.kind,
      )
    }

    it('is held while the worker still runs a row of the package', async () => {
      expect(await facts('active')).toEqual(['drainable'])
    })

    it('is held while the worker has not confirmed the latest tree yet', async () => {
      expect(await facts('disabled', false)).toEqual(['drainable'])
    })

    it('is gone once the worker confirmed the package rows are disabled', async () => {
      expect(await facts('disabled')).toEqual([])
    })

    it('is gone for a package the worker never ran', async () => {
      expect(await facts(undefined)).toEqual([])
    })

    it('is gone when no worker is alive and the tree wants the package off', async () => {
      expect(await facts('active', false, null)).toEqual([])
    })

    it('is held while the tree still wants the package on, even with no worker alive', async () => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const on = encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: `ext:${pkg}/tool`,
              plugin: `${pkg}@sha256-x/probe`,
              snapshotDigest: 'sha256-x',
              exportName: 'probe',
              entryRevision: 'sha256-x',
              extrasRevision: 'none',
              mountRevision: 'host-ordinary-row:v1',
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: revision,
          compositeRevision: revision,
        }),
      )
      store.publishDesired(on)
      const noWorker = await createCompositeReferenceFacts(store, () => undefined)(input)
      expect(noWorker.runtime.map((fact) => fact.kind)).toEqual(['drainable'])
    })

    it('is not held by a row of another package', async () => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const desired = artifact('ext:acme/other/tool')
      store.publishDesired(desired)
      store.qualifyConverged(1, desired, {
        hash: desired.identity.treeHash,
        ok: true,
        rows: [{ id: 'ext:acme/other/tool', state: 'active' }],
      } as never)
      expect((await createCompositeReferenceFacts(store, () => 1)(input)).runtime).toEqual([])
    })
  })

  describe('a package whose manifest gives its plugin an id of its own', () => {
    const pkg = 'acme/pkg'
    const customId = 'ext:vendor/custom-name'
    // The row id says nothing about the package; only the row's plugin does.
    const desired = (disabled: boolean) =>
      encodeRuntimeTargetArtifact(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: customId,
              plugin: `${pkg}@sha256-x/probe`,
              snapshotDigest: 'sha256-x',
              exportName: 'probe',
              entryRevision: 'sha256-x',
              extrasRevision: 'none',
              mountRevision: 'host-ordinary-row:v1',
              disabled,
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: revision,
          compositeRevision: revision,
        }),
      )
    const observe = async (state: string, disabled = false) => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const target = desired(disabled)
      store.publishDesired(target)
      store.qualifyConverged(1, target, {
        hash: target.identity.treeHash,
        ok: true,
        rows: [{ id: customId, state }],
      } as never)
      const adapter = createCompositeTargetActivation({
        store,
        workerGeneration: () => 1,
        contributions: () => [{ kind: 'extension' }],
      })
      return adapter.actual(profile, pkg)
    }

    it('is running while that row is active', async () => {
      expect(await observe('active')).toEqual({ actual: 'running' })
    })

    it('stays starting while that row is still coming up', async () => {
      expect(await observe('pending')).toEqual({ actual: 'starting' })
    })

    it('is not-running once that row is disabled', async () => {
      expect(await observe('disabled', true)).toEqual({ actual: 'not-running' })
    })

    it('is not called running while a row of it failed', async () => {
      expect(await observe('failed')).toEqual({ actual: 'starting' })
    })
  })

  describe('an extension-only package once the worker report is qualified', () => {
    const pkg = 'acme/pkg'
    const observe = async (state: string | undefined, converged = true) => {
      const tables = sqliteTables()
      const store = new CompositeTargetStore(tables.table('composite'), profile)
      const desired = artifact(`ext:${pkg}/tool`)
      store.publishDesired(desired)
      if (converged) {
        store.qualifyConverged(1, desired, {
          hash: desired.identity.treeHash,
          ok: true,
          rows: state === undefined ? [] : [{ id: `ext:${pkg}/tool`, state }],
        } as never)
      }
      const adapter = createCompositeTargetActivation({
        store,
        workerGeneration: () => 1,
        contributions: () => [{ kind: 'extension' }],
      })
      return adapter.actual(profile, pkg)
    }

    it('is running while its rows are active', async () => {
      expect(await observe('active')).toEqual({ actual: 'running' })
    })

    it('is not-running once its rows are disabled, so it can be removed', async () => {
      expect(await observe('disabled')).toEqual({ actual: 'not-running' })
    })

    it('is not-running when it never got a row, instead of starting forever', async () => {
      expect(await observe(undefined)).toEqual({ actual: 'not-running' })
    })

    it('stays starting while the worker has not confirmed the tree yet', async () => {
      expect(await observe('disabled', false)).toEqual({ actual: 'starting' })
    })

    it('stays starting while one of its rows is still coming up', async () => {
      expect(await observe('pending')).toEqual({ actual: 'starting' })
    })
  })

  it('surface-only actual does not wait for worker report', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    store.publishDesired(artifact('ext:surface'))
    const adapter = createCompositeTargetActivation({
      store,
      workerGeneration: () => 1,
      contributions: () => [{ kind: 'surface' }],
      surfaceRunningRevision: () => 'surf-1',
      desiredSurfaceRevision: () => 'surf-1',
    })
    expect(await adapter.actual(profile, 'acme/surface')).toEqual({ actual: 'running' })
  })

  it('client-only actual stays pending until the client roster matches', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    const desired = artifact('ext:client')
    store.publishDesired(desired)
    store.qualifyConverged(1, desired, { hash: desired.identity.treeHash, ok: true, rows: [] })
    const adapter = createCompositeTargetActivation({
      store,
      workerGeneration: () => 1,
      contributions: () => [{ kind: 'extension', client: { entry: './ui.js' } }],
      clientRosterMatch: () => false,
    })
    expect(await adapter.actual(profile, 'acme/client')).toEqual({ actual: 'starting' })
  })

  it('names running and failed actuals with the installed package identity', async () => {
    const tables = sqliteTables()
    const store = new CompositeTargetStore(tables.table('composite'), profile)
    const desired = artifact('ext:hot')
    store.publishDesired(desired)
    // A package only runs when the worker reports one of its own rows as active.
    store.qualifyConverged(3, desired, {
      hash: desired.identity.treeHash,
      ok: true,
      rows: [{ id: 'ext:@agnes-examples/hot-tool/tool', state: 'active' }],
    } as never)
    const adapter = createCompositeTargetActivation({
      store,
      workerGeneration: () => 3,
      contributions: () => [{ kind: 'extension' }],
      packageIdentity: () => ({
        version: '1.0.0',
        integrity: `sha256-${'a'.repeat(64)}`,
      }),
    })
    expect(await adapter.actual(profile, '@agnes-examples/hot-tool')).toEqual({
      actual: 'running',
      actualVersion: '1.0.0',
      actualIntegrity: `sha256-${'a'.repeat(64)}`,
    })
  })
})

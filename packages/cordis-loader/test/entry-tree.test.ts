import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '../../cordis/src/index.js'
import {
  buildMountIdentity,
  createEntryTreeHostTransaction,
  type EntryImporter,
  type EntryMountAdapter,
  type EntryRow,
  EntryTree,
  EntryTreeError,
  type InstallationUpdateResult,
  type MountIdentityInput,
} from '../src/index.js'

type Imported = { plugin: string }
type Installation = { id: string; fiber: Fiber }

function row(id: string, config: unknown = 1, revision = 'mount-1'): Readonly<EntryRow> {
  const identity: MountIdentityInput = {
    snapshotDigest: 'sha256-snapshot',
    exportName: id,
    entryRevision: 'entry-1',
    extrasRevision: 'extras-1',
    plugin: `acme/example@sha256-snapshot/${id}`,
    inject: [],
    isolate: {},
    provides: [],
    runtime: 'in-process',
    mountRevision: revision,
  }
  return {
    id,
    plugin: identity.plugin,
    config,
    inject: [],
    disabled: false,
    isolate: {},
    provides: [],
    runtime: 'in-process',
    mountIdentity: buildMountIdentity(identity),
    mountRevision: revision,
    entryRevision: 'entry-1',
    extrasRevision: 'extras-1',
  }
}

function harness() {
  const parent = new Context()
  const events: string[] = []
  let updateResult: InstallationUpdateResult = { status: 'updated' }
  let updateFailure: unknown
  const importer: EntryImporter<Imported> = async (entry) => {
    events.push(`import:${entry.id}`)
    return { plugin: entry.plugin }
  }
  const adapter: EntryMountAdapter<Imported, Installation> = {
    async mount(_parent, entry, imported) {
      events.push(`mount:${entry.id}:${imported.plugin}`)
      return { id: entry.id, fiber: parent.fiber }
    },
    async update(current, entry) {
      events.push(`update:${current.id}:${String(entry.config)}`)
      if (updateFailure !== undefined) throw updateFailure
      return updateResult
    },
    async unmount(current) {
      events.push(`unmount:${current.id}`)
    },
    fiber(current) {
      return current.fiber
    },
  }
  const tree = new EntryTree(parent, importer, adapter)
  return {
    adapter,
    events,
    parent,
    tree,
    setUpdateFailure(value: unknown) {
      updateFailure = value
    },
    setUpdateResult(value: InstallationUpdateResult) {
      updateResult = value
    },
  }
}

describe('EntryTree last-good state machine', () => {
  it('mounts additions in desired order and exposes only row snapshots', async () => {
    const { events, tree } = harness()
    const a = row('a')
    const b = row('b')
    await tree.apply([a, b])
    expect(events).toEqual(['import:a', `mount:a:${a.plugin}`, 'import:b', `mount:b:${b.plugin}`])
    expect(tree.currentRows().map(({ id }) => id)).toEqual(['a', 'b'])
    expect(tree.currentRows()).not.toBe(tree.currentRows())
  })

  it('updates config without importing again and commits only an updated result', async () => {
    const { events, tree } = harness()
    await tree.apply([row('a', 1)])
    events.length = 0
    await tree.apply([row('a', 2)])
    expect(events).toEqual(['update:a:2'])
    expect(tree.currentRows()[0]?.config).toBe(2)
  })

  it('keeps the last-good row after a restored update', async () => {
    const { setUpdateResult, tree } = harness()
    await tree.apply([row('a', 1)])
    setUpdateResult({ status: 'restored', cause: new Error('new config rejected') })
    await expect(tree.apply([row('a', 2)])).rejects.toMatchObject({ code: 'E_ROW_UPDATE' })
    expect(tree.currentRows()[0]?.config).toBe(1)
  })

  it('deletes a removed installation and remounts it on retry', async () => {
    const { events, setUpdateResult, tree } = harness()
    await tree.apply([row('a', 1)])
    setUpdateResult({ status: 'removed', cause: new Error('restore failed'), fatal: true })
    await expect(tree.apply([row('a', 2)])).rejects.toMatchObject({ code: 'E_ROW_UPDATE_FATAL' })
    expect(tree.currentRows()).toEqual([])
    setUpdateResult({ status: 'updated' })
    events.length = 0
    await tree.apply([row('a', 2)])
    expect(events).toEqual(['import:a', `mount:a:${row('a').plugin}`])
  })

  it('treats an untyped update rejection as removed and runs idempotent cleanup', async () => {
    const { events, setUpdateFailure, tree } = harness()
    await tree.apply([row('a', 1)])
    setUpdateFailure(new Error('unexpected adapter failure'))
    events.length = 0
    await expect(tree.apply([row('a', 2)])).rejects.toMatchObject({ code: 'E_ROW_UPDATE_FATAL' })
    expect(events).toEqual(['update:a:2', 'unmount:a'])
    expect(tree.currentRows()).toEqual([])
  })

  it('unmounts identity changes before importing and leaves no row after import failure', async () => {
    const base = harness()
    const importer: EntryImporter<Imported> = async (entry) => {
      if (entry.mountRevision === 'mount-1') return { plugin: entry.plugin }
      base.events.push(`import:${entry.id}:failed`)
      throw new Error('snapshot missing')
    }
    const tree = new EntryTree(base.parent, importer, base.adapter)
    await tree.apply([row('a', 1, 'mount-1')])
    base.events.length = 0
    await expect(tree.apply([row('a', 1, 'mount-2')])).rejects.toThrow('snapshot missing')
    expect(base.events).toEqual(['unmount:a', 'import:a:failed'])
    expect(tree.currentRows()).toEqual([])

    base.events.length = 0
    await tree.apply([row('a', 1, 'mount-1')])
    expect(base.events).toEqual(['mount:a:acme/example@sha256-snapshot/a'])
    expect(tree.currentRows()[0]?.mountRevision).toBe('mount-1')
  })

  it('deletes the map entry even when unmount reports aggregate cleanup diagnostics', async () => {
    const base = harness()
    const adapter: EntryMountAdapter<Imported, Installation> = {
      ...base.adapter,
      async unmount(current) {
        base.events.push(`unmount:${current.id}:failed`)
        throw new AggregateError([new Error('cleanup failed')])
      },
    }
    const tree = new EntryTree(base.parent, async (entry) => ({ plugin: entry.plugin }), adapter)
    await tree.apply([row('a')])
    base.events.length = 0
    await expect(tree.apply([])).rejects.toBeInstanceOf(AggregateError)
    expect(base.events).toEqual(['unmount:a:failed'])
    expect(tree.currentRows()).toEqual([])
  })

  it('treats disabled rows as absent and removes old rows in reverse order', async () => {
    const { events, tree } = harness()
    await tree.apply([row('a'), row('b')])
    events.length = 0
    await tree.apply([{ ...row('a'), disabled: true }])
    expect(events).toEqual(['unmount:b', 'unmount:a'])
    expect(tree.currentRows()).toEqual([])
  })

  it('rejects duplicate ids before changing live state', async () => {
    const { events, tree } = harness()
    await expect(tree.apply([row('a'), row('a', 2)])).rejects.toMatchObject({
      code: 'E_ROW_DUPLICATE',
    })
    expect(events).toEqual([])
  })

  it('does not publish a failed mount and returns the child fiber through the adapter', async () => {
    const base = harness()
    const adapter: EntryMountAdapter<Imported, Installation> = {
      ...base.adapter,
      async mount() {
        throw new Error('mount failed')
      },
    }
    const failed = new EntryTree(base.parent, async (entry) => ({ plugin: entry.plugin }), adapter)
    await expect(failed.apply([row('a')])).rejects.toThrow('mount failed')
    expect(failed.currentRows()).toEqual([])

    await base.tree.apply([row('a')])
    expect(base.tree.fiber('a')).toBe(base.parent.fiber)
    expect(base.tree.fiber('missing')).toBeUndefined()
  })

  it('does not update when the config reference and identity are unchanged', async () => {
    const { events, tree } = harness()
    const config = { value: 1 }
    await tree.apply([row('a', config)])
    events.length = 0
    await tree.apply([row('a', config)])
    expect(events).toEqual([])
  })

  it('snapshots structural fields before awaiting importer or adapter work', async () => {
    const { tree } = harness()
    const inject = ['logger']
    const isolate = { logger: 'row' }
    const provides = ['example.service']
    const mutable = {
      ...row('a'),
      inject,
      isolate,
      provides,
    }
    await tree.apply([mutable])
    inject.push('tampered')
    isolate.logger = 'tampered'
    provides.push('tampered.service')
    const current = tree.currentRows()[0]
    expect(current?.inject).toEqual(['logger'])
    expect(current?.isolate).toEqual({ logger: 'row' })
    expect(current?.provides).toEqual(['example.service'])
    expect(Object.isFrozen(current)).toBe(true)
  })

  it('uses stable machine-readable update error codes', () => {
    expect(new EntryTreeError('E_ROW_UPDATE', 'failed').code).toBe('E_ROW_UPDATE')
  })

  it('prepares imports without mounting or consuming the mount input', async () => {
    const { events, tree } = harness()
    const transaction = createEntryTreeHostTransaction(tree)
    const prepared = await transaction.prepare([row('a')])

    expect(events).toEqual(['import:a'])
    expect(tree.currentRows()).toEqual([])
    await transaction.apply(prepared)
    expect(events).toEqual(['import:a', `mount:a:${row('a').plugin}`])
    expect(tree.currentRows()).toEqual([row('a')])
  })

  it('compensates a failed candidate mount while preserving unaffected installation identity', async () => {
    const base = harness()
    const first = row('a', 1)
    const second = row('b', 1)
    const target = row('a', 1, 'mount-2')
    const failed = row('c')
    const importer: EntryImporter<Imported> = async (entry) => {
      base.events.push(`import:${entry.id}`)
      return { plugin: entry.plugin }
    }
    const adapter: EntryMountAdapter<Imported, Installation> = {
      ...base.adapter,
      async mount(parent, entry, _imported) {
        if (entry.id === failed.id) throw new Error('candidate mount rejected')
        return { id: entry.id, fiber: parent.fiber }
      },
    }
    const tree = new EntryTree(base.parent, importer, adapter)
    await tree.apply([first, second])
    const before = tree.fiber('b')
    const transaction = createEntryTreeHostTransaction(tree)
    const prepared = await transaction.prepare([target, second, failed])
    await expect(transaction.apply(prepared)).rejects.toMatchObject({ code: 'E_ROW_TRANSACTION' })
    expect(tree.currentRows()).toEqual([first, second])
    expect(tree.fiber('b')).toBe(before)
  })

  it('restores the old row when a config update fails during a transaction', async () => {
    const base = harness()
    const first = row('a', 1)
    const second = row('b', 1)
    await base.tree.apply([first, second])
    const unaffected = base.tree.fiber('b')
    base.setUpdateResult({ status: 'restored', cause: new Error('new config rejected') })
    const transaction = createEntryTreeHostTransaction(base.tree)
    const prepared = await transaction.prepare([row('a', 2), second])

    await expect(transaction.apply(prepared)).rejects.toMatchObject({ code: 'E_ROW_TRANSACTION' })
    expect(base.tree.currentRows()).toEqual([first, second])
    expect(base.tree.fiber('b')).toBe(unaffected)
  })

  it('reinstalls a deleted row when a later transaction step fails', async () => {
    const base = harness()
    const first = row('a')
    let failUnmount = true
    const adapter: EntryMountAdapter<Imported, Installation> = {
      ...base.adapter,
      async unmount(current) {
        base.events.push(`unmount:${current.id}`)
        if (current.id === 'a' && failUnmount) {
          failUnmount = false
          throw new Error('delete failed')
        }
      },
    }
    const tree = new EntryTree(base.parent, async (entry) => ({ plugin: entry.plugin }), adapter)
    await tree.apply([first])
    const transaction = createEntryTreeHostTransaction(tree)
    const prepared = await transaction.prepare([])

    await expect(transaction.apply(prepared)).rejects.toMatchObject({ code: 'E_ROW_TRANSACTION' })
    expect(tree.currentRows()).toEqual([first])
    expect(tree.fiber('a')).not.toBeUndefined()
    expect(base.events.filter((event) => event.startsWith('mount:a'))).toHaveLength(2)
  })

  it('reports compensation failure with a recovery handoff without publishing a partial row set', async () => {
    const base = harness()
    const first = row('a')
    await base.tree.apply([first])
    const adapter: EntryMountAdapter<Imported, Installation> = {
      ...base.adapter,
      async unmount(current) {
        base.events.push(`unmount:${current.id}`)
        throw new Error('unmount permanently failed')
      },
    }
    const tree = new EntryTree(base.parent, async (entry) => ({ plugin: entry.plugin }), adapter)
    await tree.apply([first])
    const transaction = createEntryTreeHostTransaction(tree)
    const prepared = await transaction.prepare([])

    await expect(transaction.apply(prepared)).rejects.toMatchObject({
      code: 'E_ROW_TRANSACTION_RECOVERY_REQUIRED',
    })
    expect(tree.currentRows()).toEqual([first])
  })
})

describe('EntryTree host transaction on a live tree', () => {
  function transactionHarness(options: { hangMountOf?: string; failMountOf?: string } = {}) {
    const parent = new Context()
    const events: string[] = []
    const importer: EntryImporter<Imported> = async (entry) => ({ plugin: entry.plugin })
    const adapter: EntryMountAdapter<Imported, Installation> = {
      async mount(_parent, entry) {
        events.push(`mount:${entry.id}:${entry.mountRevision}`)
        if (entry.mountRevision === options.hangMountOf) return new Promise<Installation>(() => undefined)
        if (entry.mountRevision === options.failMountOf) throw new Error('start failed')
        return { id: `${entry.id}:${entry.mountRevision}`, fiber: parent.fiber }
      },
      async update() {
        return { status: 'updated' }
      },
      async unmount(current) {
        events.push(`unmount:${current.id}`)
      },
      fiber(current) {
        return current.fiber
      },
    }
    const tree = new EntryTree(parent, importer, adapter)
    return { events, tree, transaction: createEntryTreeHostTransaction(tree) }
  }

  it('replace unmounts the old installation before mounting the new one', async () => {
    const { events, tree, transaction } = transactionHarness()
    await tree.apply([row('a', 1, 'v1')])
    events.length = 0
    await transaction.apply(await transaction.prepare([row('a', 1, 'v2')]))
    expect(events).toEqual(['unmount:a:v1', 'mount:a:v2'])
  })

  it('a failed replace remounts the old row through compensation', async () => {
    const { events, tree, transaction } = transactionHarness({ failMountOf: 'v2' })
    await tree.apply([row('a', 1, 'v1')])
    events.length = 0
    await expect(transaction.apply(await transaction.prepare([row('a', 1, 'v2')]))).rejects.toMatchObject({
      code: 'E_ROW_TRANSACTION',
    })
    expect(events).toEqual(['unmount:a:v1', 'mount:a:v2', 'mount:a:v1'])
    expect(tree.currentRows().map((r) => r.mountRevision)).toEqual(['v1'])
  })

  it('a hung mount times out, compensates and taints the tree', async () => {
    const { tree, transaction } = transactionHarness({ hangMountOf: 'v2' })
    await tree.apply([row('a', 1, 'v1')])
    expect(tree.tainted).toBe(false)
    const failure = await transaction
      .apply(await transaction.prepare([row('a', 1, 'v2')], { stepTimeoutMs: 20 }))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'E_ROW_TRANSACTION' })
    expect((failure as Error).cause).toMatchObject({ code: 'E_ROW_STUCK' })
    expect(tree.tainted).toBe(true)
    expect(tree.currentRows().map((r) => r.mountRevision)).toEqual(['v1'])
  })
})

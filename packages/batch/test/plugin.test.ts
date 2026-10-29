import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BASE_SEAM_PROVIDERS } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { checkServiceDef, type PersistenceMetadataNamespace, type ServiceDef } from '@agnes/extension-api'
import { createOwnedStore } from '@agnes/sdk/owned-store'
import { describe, expect, it } from 'vitest'
import {
  attachmentSnapshots,
  BatchEngine,
  BatchService,
  batchPlugin,
  createBatchPlugin,
  Repository,
  startManagedBatch,
} from '../src/index.js'
import { FakeExecutor, id, inputs, spec, testStore } from './fakes.js'

describe('batch plugin connector', () => {
  it('captures two real inputs and lets a recovered driver settle the immutable snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-batch-plugin-unit-'))
    const database = new DatabaseSync(':memory:')
    let cleanup: (() => Promise<unknown>) | undefined
    try {
      const root = await realpath(dir)
      await mkdir(join(root, 'inputs'))
      await writeFile(join(root, 'inputs/a.txt'), 'alpha')
      await writeFile(join(root, 'inputs/b.txt'), 'beta')
      let values = new Map<string, unknown>()
      const namespace: PersistenceMetadataNamespace = {
        get: (key) => structuredClone(values.get(key)),
        set: (key, value) => {
          values.set(key, structuredClone(value))
        },
        delete: (key) => {
          values.delete(key)
        },
        entries: () => [...values].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction(work) {
          const before = structuredClone(values)
          try {
            return work()
          } catch (e) {
            values = before
            throw e
          }
        },
      }
      const init = fakeSeamInit()
      init.adapters.storage.namespace = () => namespace
      const seam = await BASE_SEAM_PROVIDERS.artifacts.create(init, init.signal)
      const store = createOwnedStore(database, 'profile:synthetic/batch'),
        executor = new FakeExecutor()
      const artifacts = attachmentSnapshots(
        seam.attachments,
        async ({ batch, name }) => ({ sessionKey: `child:${batch}:${name}`, lane: 'main' }),
        init.signal,
      )
      executor.reply = (request) => ({
        state: 'completed',
        charged: 0.1,
        inputRead: true,
        text: String(request.input.size),
      })
      const binding = {
        workspaceRoot: root,
        engine: new BatchEngine(new Repository(store), executor),
        artifacts,
        signal: new AbortController().signal,
      }
      const service = new BatchService(binding)
      await service.start({ id, dir: 'inputs', spec })
      await expect(service.start({ id, dir: 'inputs', spec })).resolves.toMatchObject({
        id,
        status: 'running',
      })
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      await expect(
        artifacts.put(new TextEncoder().encode('wrong original'), {
          batch: id,
          digest: '0'.repeat(64),
          name: 'bad.txt',
        }),
      ).rejects.toMatchObject({ code: 'E_BATCH_ATTACHMENT_RECEIPT' })
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      await writeFile(join(root, 'inputs/a.txt'), 'changed after snapshot')
      const captured = await binding.engine.repo.page(id)
      expect(new TextDecoder().decode(await seam.get(captured[0]!.input.artifact!))).toBe('alpha')
      const first = captured[0]!.input
      expect(
        await seam.attachments!.authorize(
          { sessionKey: 'other-child', lane: 'main' },
          { id: first.receipt!.id, artifact: first.artifact! },
          init.signal,
        ),
      ).toBe(false)
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      const lifetime = new AbortController()
      let shutdown:
        | Parameters<import('@agnes/extension-api').ManagedServiceRuntime['onShutdown']>[0]
        | undefined
      const managed = await startManagedBatch(
        {
          instanceId: 'batch:synthetic',
          incarnation: 'incarnation:1',
          scopeId: 'profile:synthetic',
          listeners: {},
          store,
          signal: lifetime.signal,
          onShutdown(fn) {
            shutdown = fn
          },
          async ready(info) {
            expect(shutdown).toBeTypeOf('function')
            expect(info).toEqual({ apiVersion: '1.0.0', listeners: [] })
          },
        },
        { workspaceRoot: root, artifacts, executor },
      )
      cleanup = () => managed.stop('exit', AbortSignal.timeout(100))
      const recovered = managed.service
      executor.loseReply = true
      await expect(managed.tick()).rejects.toThrow('lost response')
      await managed.tick()
      expect(await recovered.status(id)).toMatchObject({ status: 'completed', spent: 0.2 })
      expect((await recovered.results(id)).items.map((item) => item.output)).toEqual([
        { text: '5' },
        { text: '4' },
      ])
      await managed.tick()
      expect(executor.executions).toBe(2)
      await symlink(join(root, 'inputs/a.txt'), join(root, 'inputs/z.txt'))
      await expect(service.start({ id: 'b000000000001', dir: 'inputs', spec })).rejects.toMatchObject({
        code: 'E_BATCH_SYMLINK',
      })
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      lifetime.abort('disable')
      await expect(shutdown!('disable', new AbortController().signal)).resolves.toEqual({ state: 'settled' })
      await expect(recovered.start({ id, dir: 'inputs', spec })).rejects.toBe('disable')
    } finally {
      await cleanup?.()
      database.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('advances more than one manifest page using the real versioned store', async () => {
    const database = new DatabaseSync(':memory:')
    try {
      const store = createOwnedStore(database, 'profile:pagination/batch')
      const executor = new FakeExecutor()
      const engine = new BatchEngine(new Repository(store), executor)
      for (let ordinal = 0; ordinal < 101; ordinal++) {
        const batch = `b${ordinal.toString(16).padStart(12, '0')}`
        await engine.begin(batch, spec, [
          {
            ...inputs[0]!,
            receipt: { id: `receipt:${batch}`, scope: { sessionKey: batch, lane: 'main' } },
          },
        ])
      }
      const service = new BatchService({
        engine,
        workspaceRoot: '/',
        signal: new AbortController().signal,
        artifacts: {
          async put() {
            throw new Error('unused')
          },
        },
      })
      await service.tick()
      expect(await service.status('b000000000064')).toMatchObject({ status: 'completed', successes: 1 })
      expect(executor.executions).toBe(101)
    } finally {
      database.close()
    }
  })
  it.each([false, true])(
    'settles disable billing or preserves unknown at deadline (hung=%s)',
    async (hung) => {
      const store = testStore(),
        executor = new FakeExecutor()
      executor.reply = () => ({ state: 'running', charged: 0.2 })
      const engine = new BatchEngine(new Repository(store), executor)
      await engine.begin(id, spec, inputs)
      await engine.tick(id)
      let shutdown!: Parameters<import('@agnes/extension-api').ManagedServiceRuntime['onShutdown']>[0]
      const managed = await startManagedBatch(
        {
          instanceId: 'batch:test',
          incarnation: 'one',
          scopeId: 'profile:test',
          listeners: {},
          store,
          signal: new AbortController().signal,
          onShutdown(fn) {
            shutdown = fn
          },
          async ready() {},
        },
        {
          executor,
          workspaceRoot: '/',
          artifacts: {
            async put() {
              throw new Error('unused')
            },
          },
        },
      )
      const deadline = new AbortController()
      if (hung) executor.cancel = async () => new Promise(() => {})
      const stopped = shutdown('disable', deadline.signal)
      if (hung) deadline.abort()
      await expect(stopped).resolves.toEqual({ state: hung ? 'unknown' : 'settled' })
      await expect(managed.service.start({ id, dir: '.', spec })).rejects.toMatchObject({
        code: 'E_BATCH_STOPPING',
      })
      expect(await engine.repo.status(id)).toMatchObject({
        spent: 0.4,
        reserved: hung ? 1.6 : 0,
        ...(hung ? {} : { status: 'cancelled' }),
      })
    },
  )
  it('registers valid query/effect definitions, cleans up partial registration, and installs the public-session managed connector', () => {
    const active = new Map<string, ServiceDef>()
    const plugin = createBatchPlugin(async () => {
      throw new Error('no invocation')
    })
    const dispose = plugin.apply({
      services: {
        register(def) {
          expect(checkServiceDef(def)).toEqual({ ok: true })
          active.set(def.name, def)
          return () => {
            active.delete(def.name)
          }
        },
      },
    })
    expect(active.get('batch.start')?.kind).toBe('effect')
    expect(active.get('batch.status')?.kind).toBe('query')
    dispose()
    expect(active.size).toBe(0)
    expect(() =>
      plugin.apply({
        services: {
          register(def) {
            if (def.name === 'batch.results') throw new Error('registration refused')
            active.set(def.name, def)
            return () => {
              active.delete(def.name)
            }
          },
        },
      }),
    ).toThrow('registration refused')
    expect(active.size).toBe(0)
    let managedId = ''
    const installed = batchPlugin.apply({
      services: {
        register: (def) => {
          active.set(def.name, def)
          return () => {
            active.delete(def.name)
          }
        },
      },
      profileRuntime: {
        async connectProducer() {
          throw new Error('no producer grant')
        },
        register(definition) {
          managedId = definition.id
          return {
            async get() {
              throw new Error('not invoked')
            },
          }
        },
        streams: {
          register() {
            throw new Error('no streams')
          },
        },
      },
    })
    expect(managedId).toBe('batchWorker')
    expect(active.has('batch.start')).toBe(true)
    installed()
    expect(() =>
      attachmentSnapshots(
        undefined,
        async () => ({ sessionKey: 's', lane: 'main' }),
        new AbortController().signal,
      ),
    ).toThrow('E_BATCH_ATTACHMENT_STORE_REQUIRED')
  })
})

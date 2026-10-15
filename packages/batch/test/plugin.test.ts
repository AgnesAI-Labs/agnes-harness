import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_SEAM_PROVIDERS } from '@agnes/base'
import { fakeSeamInit } from '@agnes/base/testkit'
import { checkServiceDef, type PersistenceMetadataNamespace, type ServiceDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import {
  attachmentSnapshots,
  BatchEngine,
  BatchService,
  batchPlugin,
  createBatchPlugin,
  Repository,
} from '../src/index.js'
import { FakeExecutor, id, MemoryStore, spec } from './fakes.js'

describe('batch plugin connector', () => {
  it('captures two real inputs and lets a recovered driver settle the immutable snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-batch-plugin-unit-'))
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
      const store = new MemoryStore(),
        executor = new FakeExecutor()
      const artifacts = attachmentSnapshots(
        seam.attachments,
        async (name) => ({ sessionKey: `child:${id}:${name}`, lane: 'main' }),
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
          digest: '0'.repeat(64),
          name: 'bad.txt',
        }),
      ).rejects.toMatchObject({ code: 'E_BATCH_ATTACHMENT_RECEIPT' })
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      await writeFile(join(root, 'inputs/a.txt'), 'changed after snapshot')
      const captured = await binding.engine.repo.page(id)
      expect(new TextDecoder().decode(await seam.get(captured[0]!.input.artifact))).toBe('alpha')
      const first = captured[0]!.input
      expect(
        await seam.attachments!.authorize(
          { sessionKey: 'other-child', lane: 'main' },
          { id: first.receipt.id, artifact: first.artifact },
          init.signal,
        ),
      ).toBe(false)
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
      const recovered = new BatchService({
        ...binding,
        engine: new BatchEngine(new Repository(store), executor),
      })
      await recovered.tick()
      expect(await recovered.status(id)).toMatchObject({ status: 'completed', spent: 0.2 })
      expect((await recovered.results(id)).items.map((item) => item.output)).toEqual([
        { text: '5' },
        { text: '4' },
      ])
      await recovered.tick()
      expect(executor.executions).toBe(2)
      await symlink(join(root, 'inputs/a.txt'), join(root, 'inputs/z.txt'))
      await expect(service.start({ id: 'b000000000001', dir: 'inputs', spec })).rejects.toMatchObject({
        code: 'E_BATCH_SYMLINK',
      })
      expect((await seam.attachments!.pendingRoots()).roots).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('registers valid query/effect definitions, cleans up partial registration, and refuses unconstrained installation', () => {
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
    expect(() => batchPlugin.apply()).toThrow('E_BATCH_MANAGED_CONNECTOR_REQUIRED')
    expect(() =>
      attachmentSnapshots(
        undefined,
        async () => ({ sessionKey: 's', lane: 'main' }),
        new AbortController().signal,
      ),
    ).toThrow('E_BATCH_ATTACHMENT_STORE_REQUIRED')
  })
})

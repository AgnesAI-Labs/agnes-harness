import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServiceDef, type ServiceDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { BatchEngine, BatchService, batchPlugin, createBatchPlugin, Repository } from '../src/index.js'
import { FakeExecutor, id, MemoryStore, spec } from './fakes.js'

describe('batch plugin connector', () => {
  it('captures two real inputs and lets a recovered driver settle the immutable snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agh-batch-plugin-unit-'))
    try {
      const root = await realpath(dir)
      await mkdir(join(root, 'inputs'))
      await writeFile(join(root, 'inputs/a.txt'), 'alpha')
      await writeFile(join(root, 'inputs/b.txt'), 'beta')
      const blobs = new Map<string, Uint8Array>(),
        store = new MemoryStore(),
        executor = new FakeExecutor()
      const artifacts = {
        put: async (bytes: Uint8Array, meta: { digest: string }) => {
          blobs.set(meta.digest, bytes.slice())
          return meta.digest
        },
      }
      executor.reply = (request) => ({
        state: 'completed',
        charged: 0.1,
        inputRead: true,
        text: String(blobs.get(request.input.artifact)?.byteLength),
      })
      const binding = {
        workspaceRoot: root,
        engine: new BatchEngine(new Repository(store), executor),
        artifacts,
        signal: new AbortController().signal,
      }
      const service = new BatchService(binding)
      await service.start({ id, dir: 'inputs', spec })
      await writeFile(join(root, 'inputs/a.txt'), 'changed after snapshot')
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
  })
})

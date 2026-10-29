import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { PersistenceMetadataPort, ServiceDef } from '@agnes/extension-api'
import { ServiceRegistry } from '@agnes/host-extensions/ext-host/services'
import { ProfileActivations } from '@agnes/host-extensions/profile/activation'
import { createProfileServiceRuntime } from '@agnes/host-extensions/profile/runtime'
import type { Actor } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { BatchEngine, BatchService, createBatchPlugin, Repository } from '../src/index.js'
import { FakeExecutor, id, inputs, spec, testStore } from './fakes.js'

/** Synthetic namespace/credentials; approval, activation, dispatch journal and context are real. */
function fixture() {
  const spaces = new Map<string, Map<string, unknown>>()
  const metadata: PersistenceMetadataPort = {
    namespace(owner, name) {
      const scope = `${owner}/${name}`
      let rows = spaces.get(scope) ?? new Map<string, unknown>()
      spaces.set(scope, rows)
      return {
        get: (key) => structuredClone(rows.get(key)),
        set(key, value) {
          rows.set(key, structuredClone(value))
        },
        delete(key) {
          rows.delete(key)
        },
        entries: () => [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction(work) {
          const previous = structuredClone(rows)
          try {
            return work()
          } catch (error) {
            rows = previous
            spaces.set(scope, rows)
            throw error
          }
        },
      }
    },
  }
  const owner = 'plugin/0123456789abcdef'
  const registry = new ServiceRegistry()
  const activations = new ProfileActivations(metadata.namespace('@host', 'activations'))
  activations.publish([{ owner, revision: 'batch:fixture' }])
  const executor = new FakeExecutor()
  const engine = new BatchEngine(new Repository(testStore()), executor)
  const binding = {
    engine,
    workspaceRoot: '/',
    signal: new AbortController().signal,
    artifacts: {
      async put() {
        throw new Error('unused')
      },
    },
  }
  const service = new BatchService(binding)
  const definitions: ServiceDef[] = []
  const dispose = createBatchPlugin(async () => service).apply({
    services: {
      register(definition) {
        definitions.push(definition)
        return registry.registerRow(definition, {
          owner,
          packageId: '@agnes/batch',
          integrity: 'batch:fixture',
          version: '1.0.0',
          signal: new AbortController().signal,
          assertAlive() {},
          assertRunning() {},
          consume() {},
        })
      },
    },
  })
  const storage = new MemoryStorage()
  const actor: Actor = { id: 'batch-operator', org: 'local', role: 'user', deptPath: [], attrs: {} }
  const make = () =>
    createProfileServiceRuntime({
      profileId: 'batch-profile',
      registry,
      activations,
      storage,
      metadata,
      signal: new AbortController().signal,
      networkAllow: [],
      clock: () => 1000,
      audit() {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
      seams: fakeSeams({
        principals: {
          resolve: async () => actor,
          authorize: async () => ({ effect: 'allow', decisionId: 'synthetic-policy', reason: 'test' }),
        },
      }),
      authority: {
        async resolve(credential) {
          if (credential !== 'local-cli') throw new Error('untrusted source')
          return {
            source: 'batch-cli',
            subjectCredential: 'operator',
            grants: definitions.map((d) => ({ extension: owner, name: d.name, range: '*' })),
          }
        },
      },
    })
  return {
    owner,
    activations,
    executor,
    engine,
    service,
    dispose,
    make,
    setWorkspace: (root: string) => {
      binding.workspaceRoot = root
    },
  }
}

describe('batch native profile admission', () => {
  it('uses durable AR1 approval and current activation for sessionless query/effect', async () => {
    const f = fixture()
    let runtime = f.make()
    try {
      await f.engine.begin(id, spec, inputs)
      const call = {
        extension: f.owner,
        service: 'batch.resume',
        input: { id },
        operationId: 'batch:resume:one',
      }
      const pending = await runtime.call(call, 'local-cli')
      expect(pending).toMatchObject({ state: 'approval-required', operationId: call.operationId })
      expect(f.executor.executions).toBe(0)
      f.setWorkspace('/changed-binding')
      await expect(runtime.call(call, 'local-cli')).rejects.toThrow()
      expect(f.executor.executions).toBe(0)
      f.setWorkspace('/')
      expect(await runtime.call(call, 'local-cli')).toEqual(pending)
      const query = await runtime.call(
        { extension: f.owner, service: 'batch.status', input: { id } },
        'local-cli',
      )
      expect(query).toMatchObject({ output: { id, status: 'running' } })
      await expect(runtime.call(Object.assign({}, call, { approved: true }), 'local-cli')).rejects.toThrow()
      await expect(runtime.call(call, 'forged')).rejects.toThrow()
      // Reopen the actual approval journal before answering; this does not redispatch work.
      await runtime.close()
      runtime = f.make()
      const decision = (await runtime.listDecisions('operator'))[0]!
      expect(decision.request.spec.subject).toMatchObject({ preparedInput: { id } })
      await runtime.answerDecision(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: 'approve:batch:one',
          response: { option: 'allowed-once', value: null },
        },
        'operator',
      )
      expect(await runtime.call(call, 'local-cli')).toMatchObject({
        state: 'completed',
        output: { status: 'completed' },
      })
      expect(f.executor.executions).toBe(2)
      expect(await runtime.call(call, 'local-cli')).toMatchObject({ state: 'completed' })
      expect(
        await runtime.readOperation(
          { extension: f.owner, service: call.service, operationId: call.operationId },
          'local-cli',
        ),
      ).toMatchObject({ state: 'completed' })
      expect(f.executor.executions).toBe(2)
      await expect(runtime.call({ ...call, input: { id: 'b000000000002' } }, 'local-cli')).rejects.toThrow()
      f.activations.publish([])
      await expect(
        runtime.call({ extension: f.owner, service: 'batch.list', input: {} }, 'local-cli'),
      ).rejects.toThrow()
    } finally {
      await runtime.close()
      f.dispose()
    }
  })
  it('admits urgent cancellation without granting new execution', async () => {
    const f = fixture(),
      runtime = f.make()
    try {
      await f.engine.begin(id, spec, inputs)
      expect(
        await runtime.call(
          { extension: f.owner, service: 'batch.cancel', input: { id }, operationId: 'cancel:one' },
          'local-cli',
        ),
      ).toMatchObject({ state: 'completed', output: { status: 'cancelled' } })
      expect(f.executor.executions).toBe(0)
      expect(await runtime.listDecisions('operator')).toEqual([])
    } finally {
      await runtime.close()
      f.dispose()
    }
  })
})

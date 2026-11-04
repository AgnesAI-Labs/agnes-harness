import { decisionSubjectDigest, MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type { PersistenceMetadataNamespace, PersistenceMetadataPort, ServiceDef } from '@agnes/extension-api'
import type { Actor, DecisionSnapshot, JsonValue, ServiceEffectPolicy } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ServiceRegistry } from '../src/ext-host/services.js'
import { ProfileActivations } from '../src/profile/activation.js'
import {
  createProfileServiceRuntime,
  type HostDecisionOwner,
  type ProfileOperation,
} from '../src/profile/runtime.js'

const plugin = 'plugin/0123456789abcdef'
const HOST_OWNER = 'core/refinement'
const actor: Actor = { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const policy: ServiceEffectPolicy = {
  isDestructive: true,
  isOpenWorld: true,
  requiresApproval: 'always',
  replay: 'never',
  approvalScopes: [],
}
const schema = {
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
} as const
const WEEK = 7 * 86_400_000

function metadata(): PersistenceMetadataPort {
  const spaces = new Map<string, Map<string, unknown>>()
  return {
    namespace(owner, name): PersistenceMetadataNamespace {
      const key = `${owner}\0${name}`
      const map = spaces.get(key) ?? new Map<string, unknown>()
      spaces.set(key, map)
      return {
        get: (key) => structuredClone(map.get(key)),
        set: (key, value) => {
          map.set(key, structuredClone(value))
        },
        delete: (key) => {
          map.delete(key)
        },
        entries: () => [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction: (work) => work(),
      }
    },
  }
}

/** A profile runtime with one plugin effect service, and a host owner the test controls. */
function fixture(o: { activate?: boolean } = {}) {
  const storage = new MemoryStorage()
  const meta = metadata()
  const registry = new ServiceRegistry()
  const activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  activations.publish(o.activate === false ? [] : [{ owner: plugin, revision: 'snapshot-one' }])
  let now = 1000
  let enabled = true
  const handler = vi.fn(async (input: JsonValue) => input)
  const register = (owner: string) =>
    registry.registerRow(
      {
        name: 'reports.publish',
        scope: 'profile',
        kind: 'effect',
        effectPolicy: policy,
        inputSchema: schema,
        outputSchema: schema,
        timeoutMs: 30000,
        maxResultBytes: 65536,
        handler,
      } as unknown as ServiceDef,
      {
        owner,
        packageId: '@acme/reports',
        integrity: 'snapshot-one',
        version: '1.0.0',
        declaredCapabilities: {},
        signal: new AbortController().signal,
        assertAlive: () => {
          if (!enabled) throw new Error('disabled')
        },
        assertRunning() {},
        consume() {},
      },
    )
  if (o.activate !== false) register(plugin)
  const state = { alive: true }
  const answered: { operation: ProfileOperation; decision: DecisionSnapshot }[] = []
  const alive = vi.fn((_operation: ProfileOperation) => state.alive)
  const owner: HostDecisionOwner = {
    alive,
    answered: async (operation, decision) => {
      answered.push({ operation, decision })
    },
  }
  const runtime = createProfileServiceRuntime({
    profileId: 'default',
    hostOwners: new Map([[HOST_OWNER, owner]]),
    registry,
    activations,
    storage,
    metadata: meta,
    log: logger,
    seams: fakeSeams({
      principals: {
        resolve: async () => actor,
        authorize: async () => ({ effect: 'allow', decisionId: 'permit', reason: 'fixture' }),
      },
    }),
    authority: {
      resolve: async () => ({
        source: 'report-panel',
        subjectCredential: 'human',
        grants: [{ extension: plugin, name: 'reports.publish', range: '*' }],
      }),
    },
    clock: () => now,
    signal: new AbortController().signal,
    networkAllow: [],
    audit: () => undefined,
  })
  /** What the host owner does to ask: one decision and its operation row, as plugin effects are kept. */
  const ask = async (operationId = 'save-1', activationId = 'host') => {
    const { journal, actor: requester } = await runtime.hostDecisions('human')
    const source = {
      owner: HOST_OWNER,
      operationId,
      sourcePackage: 'host',
      packageVersion: '1',
      alive() {},
    }
    const decision = await journal
      .decisions(requester, WEEK)
      .port(source)
      .request({
        key: operationId,
        purpose: 'memory.write',
        subject: { diff: '+ a line', baseHash: 'base', newHash: 'new' },
        prompt: 'Save this?',
        options: ['allowed-once', 'rejected'],
        responseSchema: { type: 'null' },
      })
    const input = { paragraphId: 'r1' }
    const operation: ProfileOperation = {
      key: decisionSubjectDigest({ owner: HOST_OWNER, operationId }),
      control: null,
      requestDigest: decisionSubjectDigest({ input }),
      digest: decisionSubjectDigest({ input, prepared: null }),
      actorId: requester.id,
      owner: HOST_OWNER,
      service: 'workspace-save',
      source: 'refinement',
      activationId,
      receipt: { state: 'approval-required', operationId, decision },
      input,
      prepared: null,
    }
    await journal.locked(() => journal.write(operation))
    return { decision, operation }
  }
  const answer = async (snapshot: DecisionSnapshot, option = 'allowed-once') =>
    runtime.answerDecision(
      {
        handle: snapshot.handle,
        revision: snapshot.revision,
        commandId: `answer:${snapshot.handle.id}`,
        response: { option, value: null },
      },
      'human',
    )
  return {
    runtime,
    registry,
    activations,
    handler,
    register,
    state,
    alive,
    answered,
    ask,
    answer,
    time: (value: number) => {
      now = value
    },
    disable: () => {
      enabled = false
      activations.publish([])
    },
  }
}

describe('host-owned decisions in the profile decision journal', () => {
  it('a pending promotion lists in profile.decisions.list without any plugin activation', async () => {
    const f = fixture({ activate: false })
    try {
      const { decision, operation } = await f.ask()
      const listed = await f.runtime.listDecisions('human')
      expect(listed.map((value) => value.handle.id)).toEqual([decision.id])
      expect(listed[0]?.request).toMatchObject({ owner: HOST_OWNER, operationId: 'save-1' })
      // The owner, not the plugin registry or activations, says whether it still stands.
      expect(f.alive).toHaveBeenCalledWith(expect.objectContaining({ key: operation.key }))
      // Kept as long as the owner asks, and never answered by anyone but a person.
      expect(Date.parse(listed[0]?.request.expiresAt ?? '') - 1000).toBe(WEEK)
      expect(listed[0]?.result).toBeNull()
    } finally {
      await f.runtime.close()
    }
  })

  it('a host-owned decision whose owner no longer stands by it is withdrawn and handed back', async () => {
    const f = fixture()
    try {
      const { decision } = await f.ask()
      f.state.alive = false
      expect(await f.runtime.listDecisions('human')).toEqual([])
      expect(f.answered).toHaveLength(1)
      expect(f.answered[0]?.decision.handle.id).toBe(decision.id)
      expect(f.answered[0]?.decision.result).toMatchObject({ reason: 'unavailable' })
      // Withdrawn for good: the owner coming back does not revive it.
      f.state.alive = true
      expect(await f.runtime.listDecisions('human')).toEqual([])
    } finally {
      await f.runtime.close()
    }
  })

  it('an answer goes to the owner, and only while the owner stands by the decision', async () => {
    const f = fixture()
    try {
      await f.ask('save-1')
      await f.ask('save-2')
      const [first, second] = await f.runtime.listDecisions('human')
      await f.answer(first as DecisionSnapshot)
      expect(f.answered).toHaveLength(1)
      expect(f.answered[0]?.operation.receipt.operationId).toBe('save-1')
      expect(f.answered[0]?.decision.result).toMatchObject({
        reason: 'answered',
        response: { option: 'allowed-once' },
      })
      f.state.alive = false
      await expect(f.answer(second as DecisionSnapshot)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(f.answered).toHaveLength(1)
    } finally {
      await f.runtime.close()
    }
  })

  it('an expired host decision is handed back to its owner once', async () => {
    const f = fixture()
    try {
      await f.ask()
      f.time(1000 + WEEK)
      expect(await f.runtime.listDecisions('human')).toEqual([])
      expect(f.answered.map((entry) => entry.decision.result?.reason)).toEqual(['expired'])
    } finally {
      await f.runtime.close()
    }
  })

  it('plugin service decisions list and answer exactly as before', async () => {
    const f = fixture()
    try {
      const call = { extension: plugin, service: 'reports.publish', operationId: 'one', input: { value: 1 } }
      expect(await f.runtime.call(call, 'granted')).toMatchObject({ state: 'approval-required' })
      const [pending] = await f.runtime.listDecisions('human')
      expect(pending?.request.owner).toBe(plugin)
      await f.answer(pending as DecisionSnapshot)
      expect(await f.runtime.call(call, 'granted')).toMatchObject({
        state: 'completed',
        output: { value: 1 },
      })
      expect(f.handler).toHaveBeenCalledTimes(1)
      // A plugin decision whose activation is gone is withdrawn the way it always was.
      expect(
        await f.runtime.call({ ...call, operationId: 'two', input: { value: 2 } }, 'granted'),
      ).toMatchObject({ state: 'approval-required' })
      f.disable()
      expect(await f.runtime.listDecisions('human')).toEqual([])
      // The host owner is never asked about plugin decisions.
      expect(f.alive).not.toHaveBeenCalled()
      expect(f.answered).toEqual([])
    } finally {
      await f.runtime.close()
    }
  })

  it('an operation under a host owner name that the Host did not write is not routed to the owner', async () => {
    const f = fixture({ activate: false })
    try {
      // What an in-process extension registered under the same name would leave: an ordinary activation id.
      await f.ask('foreign', '7f9c2ba4-e88f-4b2c-9c4c-8d1f5e0a6b3d')
      expect(await f.runtime.listDecisions('human')).toEqual([])
      expect(f.alive).not.toHaveBeenCalled()
      expect(f.answered).toEqual([])
    } finally {
      await f.runtime.close()
    }
  })
})

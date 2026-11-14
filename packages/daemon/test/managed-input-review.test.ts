import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { authGate } from '@agnes/daemon-rpc/local/auth'
import { requireSessionOwner } from '@agnes/daemon-rpc/local/methods/agnes'
import type { ManagedInputResult } from '@agnes/extension-api'
import { grantKey } from '@agnes/plugin-runtime/host'
import { rpcError } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import {
  type ManagedInputReviewEngine,
  type ReceiptCommand,
  registerManagedInputReview,
  registerOwnerInputReview,
} from '../src/supervisor/managed-input-review.js'
import type { ManagedInputRow } from '../src/supervisor/managed-session-inputs.js'
import { ManagedSessionRecords } from '../src/supervisor/managed-session-records.js'
import { memoryTable } from './fixtures/fake-input-ports.js'

const SERVICE = 'ext:@example/companion/main'

function row(over: Partial<ManagedInputRow> = {}): ManagedInputRow {
  return {
    owner: SERVICE,
    sessionId: 's1',
    key: 'k1',
    bindingDigest: 'b'.repeat(64),
    actorOwner: SERVICE,
    receiptId: null,
    kind: 'legacyOwnerMessage',
    taskId: 'T-1',
    taskGeneration: 2,
    startKey: 'start-1',
    contentDigest: null,
    text: 'ship the release notes',
    source: { kind: 'legacy', originalInbox: null },
    state: 'recoveryUnknown',
    reason: 'legacySourceUnknown',
    version: 3,
    itemCommandId: null,
    submittedSeq: null,
    consumedTurn: null,
    consumedSeq: null,
    history: [
      { version: 1, state: 'queued', reason: 'eligible', at: 1_000, by: 'platform' },
      { version: 2, state: 'recoveryUnknown', reason: 'legacySourceUnknown', at: 2_000, by: 'platform' },
      { version: 3, state: 'recoveryUnknown', reason: 'legacySourceUnknown', at: 3_000, by: 'platform' },
    ],
    createdAt: 1_000,
    updatedAt: 3_000,
    ...over,
  }
}

/** A stand-in for the owner input engine: one row, decisions move it the way the engine does. */
function fakeEngine(initial = row(), refuse?: string) {
  let current = initial
  const decisions: unknown[] = []
  const engine: ManagedInputReviewEngine = {
    review(sessionId, key) {
      if (sessionId !== current.sessionId || key !== current.key) return undefined
      return {
        input: structuredClone(current),
        binding: {
          taskId: current.taskId,
          taskGeneration: current.taskGeneration,
          startKey: current.startKey,
        },
      }
    },
    async decide(sessionId, key, decision, expectVersion) {
      decisions.push({ sessionId, key, decision, expectVersion })
      if (refuse) throw rpcError('SEMANTIC_REJECTED', { code: refuse })
      const [state, reason] =
        decision === 'deliver'
          ? (['enqueued', 'eligible'] as const)
          : decision === 'retain'
            ? (['retained', 'ownerRetained'] as const)
            : (['retained', 'ownerDiscarded'] as const)
      const version = current.version + 1
      current = {
        ...current,
        state,
        reason,
        version,
        history: [...current.history, { version, state, reason, at: 4_000, by: 'owner' }],
      }
      return {
        state,
        reason,
        version,
        inputId: key,
        reviewLocation: `/?session=${sessionId}&ownerInput=${key}`,
      } as ManagedInputResult
    },
  }
  return { engine, decisions, current: () => current }
}

type Listener = 'web' | 'unix'
const opened: LocalEndpoint[] = []
afterEach(async () => {
  for (const ep of opened.splice(0)) await ep.close()
})

const ownerGate = requireSessionOwner({
  sessionOwnership: {
    resolve: (id: string) => ({ principalId: id === 'foreign' ? 'jwt:someone-else' : 'local' }),
  } as never,
  registry: { get: () => ({}) } as never,
  workspaces: { sessionPath: () => undefined },
})

async function setup(
  options: {
    listener?: Listener
    clientId?: string
    engine?: ReturnType<typeof fakeEngine>
    register?: (ep: LocalEndpoint) => void
  } = {},
) {
  const fake = options.engine ?? fakeEngine()
  const receiptCalls: ReceiptCommand[] = []
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  opened.push(ep)
  // The owner's browser page reaches the daemon through the local Web listener; every local program
  // (the CLI, a bundled app's SDK client) opens the Unix socket. Both present the local credential.
  const config =
    (options.listener ?? 'web') === 'web'
      ? { transport: 'ws' as const, localWeb: true }
      : { transport: 'unix' as const }
  ep.register(
    'initialize',
    authGate(ep, { config, nonces: { consume: () => true }, clock: () => 0 }, async (_params, cx) => {
      cx.conn.initialized = true
      return { protocolVersion: 1 }
    }),
  )
  await ep.handle({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: {
        'ai.agnes.harness': { clientId: options.clientId ?? 'web', auth: { kind: 'local' } },
      },
    },
  })
  if (options.register) options.register(ep)
  else
    registerManagedInputReview(ep, {
      engine: fake.engine,
      requireOwner: ownerGate,
      receiptOwner: (sessionId) => (sessionId === 's1' ? SERVICE : undefined),
      async receipts(command) {
        receiptCalls.push(command)
        if (command.op === 'parked')
          return {
            receipts: [
              {
                receiptId: 'r'.repeat(64),
                service: 'companion',
                kind: 'message',
                text: 'are you there?',
                at: '2026-11-14T00:00:00.000Z',
                attempts: 5,
              },
            ],
          }
        return { receipt: command.op === 'redeliver' ? 'pending' : 'discarded' }
      },
    })
  let id = 1
  const call = async (method: string, params: unknown) => {
    const reply = (await ep.handle({ jsonrpc: '2.0', id: id++, method, params })) as {
      result?: unknown
      error?: { code: number; message: string; data: { code: string } & Record<string, unknown> }
    }
    return reply
  }
  return { ep, fake, receiptCalls, call }
}

const decideInput = (decision: 'deliver' | 'retain' | 'discard', version: number) => ({
  sessionId: 's1',
  target: { kind: 'input', key: 'k1', decision, version },
})

it("get returns text, source, binding, state, reason, version and history, plus the owner's parked receipts", async () => {
  const { call, receiptCalls } = await setup()
  const reply = await call('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'k1' })
  expect(reply.error).toBeUndefined()
  expect(reply.result).toEqual({
    input: {
      key: 'k1',
      kind: 'legacyOwnerMessage',
      state: 'recoveryUnknown',
      reason: 'legacySourceUnknown',
      version: 3,
      text: 'ship the release notes',
      source: { kind: 'legacy', originalInbox: null },
      binding: { taskId: 'T-1', taskGeneration: 2, startKey: 'start-1' },
      history: [
        { version: 1, state: 'queued', reason: 'eligible', at: '1970-01-01T00:00:01.000Z', by: 'platform' },
        {
          version: 2,
          state: 'recoveryUnknown',
          reason: 'legacySourceUnknown',
          at: '1970-01-01T00:00:02.000Z',
          by: 'platform',
        },
        {
          version: 3,
          state: 'recoveryUnknown',
          reason: 'legacySourceUnknown',
          at: '1970-01-01T00:00:03.000Z',
          by: 'platform',
        },
      ],
    },
    parkedReceipts: [
      {
        receiptId: 'r'.repeat(64),
        service: 'companion',
        kind: 'message',
        text: 'are you there?',
        at: '2026-11-14T00:00:00.000Z',
        attempts: 5,
      },
    ],
  })
  expect(receiptCalls).toEqual([{ op: 'parked', owner: SERVICE }])
  // A consumed input names the turn that took it; an unknown key reads as null with the receipts still listed.
  const consumed = await setup({
    engine: fakeEngine(row({ state: 'consumed', reason: 'eligible', consumedTurn: 7, consumedSeq: 41 })),
  })
  const read = await consumed.call('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'k1' })
  expect(read.result).toMatchObject({ input: { state: 'consumed', turn: 7, seq: 41 } })
  const missing = await call('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'other' })
  expect(missing.result).toMatchObject({ input: null, parkedReceipts: [{ attempts: 5 }] })
})

it('decide deliver, retain and discard return the new state and version', async () => {
  for (const [decision, state, version] of [
    ['deliver', 'enqueued', 4],
    ['retain', 'retained', 4],
    ['discard', 'retained', 4],
  ] as const) {
    const { call, fake } = await setup()
    const reply = await call('_agnes/v1/managedInput.decide', decideInput(decision, 3))
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({ state, version })
    expect(fake.decisions).toEqual([{ sessionId: 's1', key: 'k1', decision, expectVersion: 3 }])
  }
})

it('a stale version is refused with SEMANTIC_REJECTED VERSION_CHANGED', async () => {
  const { call, fake } = await setup()
  const reply = await call('_agnes/v1/managedInput.decide', decideInput('deliver', 2))
  expect(reply.error).toMatchObject({ message: 'SEMANTIC_REJECTED', data: { code: 'VERSION_CHANGED' } })
  expect(fake.decisions).toEqual([])
  expect(fake.current().version).toBe(3)
})

it("the engine's refusal codes reach the caller in data.code", async () => {
  for (const code of [
    'OWNER_INPUT_STALE',
    'OWNER_INPUT_FINAL',
    'OWNER_INPUT_UNKNOWN',
    'OWNER_INPUT_NO_TEXT',
    'OWNER_INPUT_SUBMITTED',
  ]) {
    const { call } = await setup({ engine: fakeEngine(row(), code) })
    const reply = await call('_agnes/v1/managedInput.decide', decideInput('deliver', 3))
    expect(reply.error).toMatchObject({ message: 'SEMANTIC_REJECTED', data: { code } })
  }
  // A key the engine does not know is refused before the engine is asked, with the engine's code.
  const { call, fake } = await setup()
  const missing = await call('_agnes/v1/managedInput.decide', {
    sessionId: 's1',
    target: { kind: 'input', key: 'other', decision: 'retain', version: 1 },
  })
  expect(missing.error).toMatchObject({ message: 'SEMANTIC_REJECTED', data: { code: 'OWNER_INPUT_UNKNOWN' } })
  expect(fake.decisions).toEqual([])
})

it('a caller that does not own the session is refused CAPABILITY_DENIED', async () => {
  const { call, fake, receiptCalls } = await setup()
  const read = await call('_agnes/v1/managedInput.get', { sessionId: 'foreign', key: 'k1' })
  expect(read.error).toMatchObject({ message: 'CAPABILITY_DENIED' })
  const decided = await call('_agnes/v1/managedInput.decide', {
    ...decideInput('deliver', 3),
    sessionId: 'foreign',
  })
  expect(decided.error).toMatchObject({ message: 'CAPABILITY_DENIED' })
  expect(fake.decisions).toEqual([])
  expect(receiptCalls).toEqual([])
})

it('bundled app owner client cannot decide owner inputs', async () => {
  // A bundled app's local SDK client holds the owner's local credential but comes in over the Unix
  // socket, not the owner's Web page: it may neither read nor decide, whatever client id it claims.
  for (const clientId of ['app:@example/companion', 'web']) {
    const { call, fake, receiptCalls } = await setup({ listener: 'unix', clientId })
    const read = await call('_agnes/v1/managedInput.get', { sessionId: 's1', key: 'k1' })
    expect(read.error).toMatchObject({
      message: 'CAPABILITY_DENIED',
      data: { reason: 'owner web page required' },
    })
    const decided = await call('_agnes/v1/managedInput.decide', decideInput('deliver', 3))
    expect(decided.error).toMatchObject({ message: 'CAPABILITY_DENIED' })
    const receipt = await call('_agnes/v1/managedInput.decide', {
      sessionId: 's1',
      target: { kind: 'receipt', receiptId: 'r'.repeat(64), decision: 'redeliver' },
    })
    expect(receipt.error).toMatchObject({ message: 'CAPABILITY_DENIED' })
    expect(fake.decisions).toEqual([])
    expect(receiptCalls).toEqual([])
  }
})

it('receipt redeliver and discard are routed to the worker', async () => {
  const { call, receiptCalls } = await setup()
  const receiptId = 'r'.repeat(64)
  const redeliver = await call('_agnes/v1/managedInput.decide', {
    sessionId: 's1',
    target: { kind: 'receipt', receiptId, decision: 'redeliver' },
  })
  expect(redeliver.result).toEqual({ receipt: 'pending' })
  const discard = await call('_agnes/v1/managedInput.decide', {
    sessionId: 's1',
    target: { kind: 'receipt', receiptId, decision: 'discard' },
  })
  expect(discard.result).toEqual({ receipt: 'discarded' })
  expect(receiptCalls).toEqual([
    { op: 'redeliver', owner: SERVICE, receiptId },
    { op: 'discard', owner: SERVICE, receiptId },
  ])
})

it('the daemon wiring reaches a parked receipt only through a session of the service that holds it', async () => {
  // Real session records: each managed session's owner is its service's grant key, which is also the
  // receipt store's owner. The worker stand-in keys parked receipts by owner, as the receipt store does.
  const records = new ManagedSessionRecords(memoryTable())
  const ownerA = grantKey('@example/a', 'plugin/aaaa')
  const ownerB = grantKey('@example/b', 'plugin/bbbb')
  const session = (sessionId: string, owner: string) =>
    records.insert({
      sessionId,
      owner,
      startKey: `start-${sessionId}`,
      bundle: '@example/x#worker',
      workspace: '/work',
      retention: 'task',
      permission: 'default',
      model: null,
      memoryWrites: false,
      skillInstalls: false,
    })
  session('sa', ownerA)
  session('sb', ownerB)
  const receiptId = 'a'.repeat(64)
  const parked = new Map([[`${ownerA}\u0000${receiptId}`, 'parked']])
  const commands: Record<string, unknown>[] = []
  const worker = {
    async command(_method: 'channels.receipts', params: Record<string, unknown>) {
      commands.push(params)
      const key = `${String(params.owner)}\u0000${String(params.receiptId)}`
      if (params.op === 'parked') return { receipts: [] }
      if (parked.get(key) !== 'parked') throw rpcError('SEMANTIC_REJECTED', { code: 'RECEIPT_NOT_PARKED' })
      parked.set(key, 'pending')
      return { receipt: 'pending' }
    },
  }
  const { call } = await setup({
    register: (ep) =>
      registerOwnerInputReview(ep, {
        engine: fakeEngine().engine,
        records,
        requireOwner: ownerGate,
        worker: async () => worker,
      }),
  })
  const decide = (sessionId: string) =>
    call('_agnes/v1/managedInput.decide', {
      sessionId,
      target: { kind: 'receipt', receiptId, decision: 'redeliver' },
    })
  // Through a session of package B the receipt of package A's service is not reachable.
  const refused = await decide('sb')
  expect(refused.error).toMatchObject({ message: 'SEMANTIC_REJECTED', data: { code: 'RECEIPT_NOT_PARKED' } })
  expect(parked.get(`${ownerA}\u0000${receiptId}`)).toBe('parked')
  // Through a session of package A it is redelivered.
  const accepted = await decide('sa')
  expect(accepted.result).toEqual({ receipt: 'pending' })
  expect(commands).toEqual([
    { op: 'redeliver', owner: ownerB, receiptId },
    { op: 'redeliver', owner: ownerA, receiptId },
  ])
  // A session the records do not hold, or one detached by a package removal, reaches no receipts at all.
  records.releasePackage('@example/a')
  const detachedSession = await decide('sa')
  expect(detachedSession.error).toMatchObject({ data: { code: 'RECEIPT_NOT_PARKED' } })
  const unknown = await decide('nope')
  expect(unknown.error).toMatchObject({ data: { code: 'RECEIPT_NOT_PARKED' } })
  expect(commands).toHaveLength(2)
})

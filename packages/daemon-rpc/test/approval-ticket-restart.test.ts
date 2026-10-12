import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presets as basePresets, seams as baseSeams } from '@agnes/base'
import { operations } from '@agnes/code'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { createTestHost } from '@agnes/host/testkit'
import type { Actor, InferenceEvent } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { notifyApprovalConnectionAttached, PrompterRouter } from '../src/local/prompter.js'
import { testWorkspaceCatalog } from './host.js'

const REQUESTER: Actor = { id: 'requester', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const APPROVER: Actor = { id: 'approver', org: 'local', role: 'admin', deptPath: [], attrs: {} }

const toolCall = (): InferenceEvent[] => [
  {
    type: 'toolcall_end',
    via: 'native',
    call: { toolUseId: '', name: 'shell', args: { command: 'echo restart-safe' }, ordinal: 0 },
  },
  { type: 'done', reason: 'toolUse' },
]

describe('durable approval restart', () => {
  it('reopens the original decision through SDK after the endpoint closes, without a ticket index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-decision-restart-'))
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
      packages: { '@agnes/code': { operations } },
      seams: {
        approval: { ask: async () => ({ verdict: 'unavailable', reason: 'no-handler' }) },
        principals: {
          resolve: async (_credential, surface) => (surface === 'approval' ? APPROVER : REQUESTER),
        },
      },
      script: [toolCall(), [{ type: 'done', reason: 'stop' }]],
    })
    const workspaces = await testWorkspaceCatalog(root)
    let client = createClient({
      transport: { kind: 'inproc', endpoint: createLocalEndpoint(host, { workspaces }) },
      journal: memoryJournal(),
    })
    try {
      await client.initialize()
      const session = await client.session.new({ cwd: root })
      expect(await session.prompt('run')).toMatchObject({ reason: 'parked' })
      const [original] = (await client.approval.list(session.id)).decisions
      expect(original?.result).toBeNull()
      expect(original?.request.spec.subject).toMatchObject({
        call: { name: 'shell', args: { command: 'echo restart-safe' } },
      })
      await client.close()
      client = createClient({
        transport: { kind: 'inproc', endpoint: createLocalEndpoint(host, { workspaces }) },
        journal: memoryJournal(),
      })
      await client.initialize()
      expect((await client.approval.list(session.id)).decisions).toEqual([original])
      const command = {
        ...original!.handle,
        revision: original!.revision,
        commandId: 'review',
        response: { option: 'allowed-once', value: null },
      }
      const receipt = await client.approval.decide(command)
      await expect(client.approval.decide(command)).resolves.toEqual(receipt)
      await expect(
        client.approval.decide({ ...command, response: { option: 'rejected', value: null } }),
      ).rejects.toMatchObject({ data: { code: 'APPROVAL_REJECTED' } })
      const reopened = await client.session.load(session.id, { cwd: root })
      expect((await reopened.projectUI(undefined, { surface: 'tui' })).nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'approval',
            state: 'decided',
            decisionRef: { ...original!.handle, revision: expect.any(Number) },
            decision: expect.objectContaining({ verdict: 'allowed-once', byLabel: APPROVER.id }),
          }),
        ]),
      )
      const backend = host.kernel.get(session.id)!
      await vi.waitFor(async () =>
        expect((await backend.decisions.get(original!.handle)).consumption?.effectId).toEqual(
          expect.any(String),
        ),
      )
      expect(await backend.scan({ type: 'tool/call', toSeq: backend.lastSeq })).toHaveLength(1)
    } finally {
      await client.close()
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Production uses a shared router and keeps the Host session alive across socket closures.
// Embedded endpoints have a different lifetime and deliberately abort their own sessions.
it('re-offers a real Host tool approval after its client disconnects without recording a refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-approval-reconnect-'))
  const first = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  const second = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  first.conn.capabilities.permission = true
  let live = [first]
  const router = new PrompterRouter({
    clock: Date.now,
    connections: () => live.map((endpoint) => endpoint.conn),
    originOf: () => first.conn,
    endpointFor: (connection) => {
      const endpoint = live.find((candidate) => candidate.conn === connection)
      if (!endpoint) throw new Error('connection is gone')
      return endpoint
    },
  })
  const { host } = await createTestHost({
    dataDir: root,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: {
      '@agnes/base': { seams: { approval: baseSeams.approval }, presets: basePresets },
      '@agnes/code': { operations },
    },
    prompter: (request, options) => router.ask(request, options),
    script: [toolCall(), [{ type: 'done', reason: 'stop' }]],
  })
  try {
    const session = await host.createSession({ cwd: root })
    await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'run' }] })
    const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
    const original = (await first.notifications[Symbol.asyncIterator]().next()).value as {
      params: { _meta: { 'ai.agnes.harness': { requestId: string } } }
    }
    const [pending] = await session.decisions.list()
    expect(pending?.handle.id).toBe(original.params._meta['ai.agnes.harness'].requestId)
    expect(pending?.result).toBeNull()
    await first.close()
    live = [second]
    second.conn.capabilities.permission = true
    second.conn.attached.set(session.key, {
      cursor: { fromSeq: 0, generation: 1 },
      filter: { preview: false, acpUpdates: true },
    })
    notifyApprovalConnectionAttached(second.conn)
    const offered = (await second.notifications[Symbol.asyncIterator]().next()).value as {
      id: string
      params: typeof original.params
    }
    expect(offered.params._meta['ai.agnes.harness'].requestId).toBe(
      original.params._meta['ai.agnes.harness'].requestId,
    )
    expect(await session.scan({ type: 'approval/decided', toSeq: session.lastSeq })).toEqual([])
    await second.handle({
      jsonrpc: '2.0',
      id: offered.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(running).resolves.toMatchObject({ reason: 'completed' })
    const decisions = await session.decisions.list()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      result: { reason: 'answered', response: { option: 'allowed-once' } },
      consumption: { effectId: expect.any(String) },
    })
    const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
    expect(results).toHaveLength(1)
    expect(results[0]?.data).not.toMatchObject({ isError: true })
  } finally {
    await first.close()
    await second.close()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('answers a real verifier pending through the same native command without changing its domain storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-domain-review-'))
  let checks = 0
  let binding: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  const { host } = await createTestHost({
    dataDir: root,
    seams: {
      verifier: {
        verify: async () =>
          ++checks === 1
            ? { verdict: 'needs_revision', reasons: ['review draft'] }
            : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'park' },
      approval: {
        ask: async (request) => {
          binding = {
            requestId: request.requestId,
            bindingHash: request.bindingHash,
            expiresAt: request.deadline,
          }
          return { ticket: 'domain-review', expiresAt: request.deadline }
        },
        resume: async () => binding,
      },
      principals: { resolve: async () => REQUESTER },
    },
    script: [
      [
        { type: 'text_delta', delta: 'draft' },
        { type: 'done', reason: 'stop' },
      ],
      [
        { type: 'text_delta', delta: 'reviewed' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const workspaces = await testWorkspaceCatalog(root)
  const client = createClient({
    transport: { kind: 'inproc', endpoint: createLocalEndpoint(host, { workspaces }) },
    journal: memoryJournal(),
  })
  try {
    await client.initialize()
    const session = await client.session.new({ cwd: root })
    expect(await session.prompt('review')).toMatchObject({ reason: 'parked' })
    const node = (await session.projectUI()).nodes.find((node) => node.kind === 'approval')
    if (node?.kind !== 'approval' || !node.decisionRef) throw new Error('Missing domain review')
    const command = {
      ...node.decisionRef,
      commandId: 'native-domain-review',
      response: { option: 'allowed-once', value: null },
    }
    const receipt = await client.approval.decide(command)
    expect(await client.approval.decide(command)).toEqual(receipt)
    await expect(client.approval.decide({ ...command, commandId: 'other' })).rejects.toMatchObject({
      data: { code: 'APPROVAL_REJECTED' },
    })
    const backend = host.kernel.get(session.id)!
    expect(backend.state.registers.decisionStates.size).toBe(0)
    expect(backend.state.decisions.get(node.decisionRef.id)?.answeredBy).toEqual(REQUESTER)
    expect(backend.state.decisions.get(node.decisionRef.id)?.answerCommand).toEqual(receipt)
  } finally {
    await client.close()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

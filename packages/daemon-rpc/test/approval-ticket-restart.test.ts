import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presets as basePresets } from '@agnes/base'
import { operations } from '@agnes/code'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { baseSeamFactories, createTestHost } from '@agnes/host/testkit'
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
      expect(original?.handle.sessionId).toBe(session.id)
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
        id: original!.handle.id,
        sessionId: session.id,
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
      '@agnes/base': { seams: { approval: baseSeamFactories.approval }, presets: basePresets },
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

it('recovers verifier failures without creating manual approval decisions or accepting an old ticket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-domain-review-'))
  let checks = 0
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
          return { ticket: 'domain-review', expiresAt: request.deadline }
        },
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
    expect(await session.prompt('review')).toMatchObject({ reason: 'completed' })
    expect(checks).toBe(2)
    const projection = await session.projectUI()
    expect(projection.nodes.filter((node) => node.kind === 'approval')).toEqual([])
    expect(JSON.stringify(projection.nodes)).toContain('reviewed')
    expect((await client.approval.list(session.id)).decisions).toEqual([])
    const backend = host.kernel.get(session.id)!
    expect(backend.state.registers.decisionStates.size).toBe(0)
    const signals = await backend.scan({ type: 'verifier/signal', toSeq: backend.lastSeq })
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ verdict: 'needs_revision' }) }),
        expect.objectContaining({ data: expect.objectContaining({ scope: 'turn', verdict: 'pass' }) }),
      ]),
    )
    expect(signals.map((row) => (row.data as { verdict: string }).verdict)).toEqual([
      'needs_revision',
      'pass',
    ])
    const before = backend.lastSeq
    await expect(
      client.approval.decide({
        sessionId: session.id,
        id: 'domain-review',
        revision: 1,
        commandId: 'retired-domain-review',
        response: { option: 'allowed-once', value: null },
      }),
    ).rejects.toMatchObject({ data: { code: 'APPROVAL_REJECTED' } })
    expect(backend.lastSeq).toBe(before)
    expect(backend.state.registers.decisionStates.size).toBe(0)
  } finally {
    await client.close()
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})

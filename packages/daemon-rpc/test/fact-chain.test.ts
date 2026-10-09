import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { AuthoringCandidate, EventEnvelope, FactChainParams, FactChainResult } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerFactChain } from '../src/local/methods/fact-chain.js'

const row = (seq: number, type: string, data: unknown, extra = {}): EventEnvelope =>
  ({
    seq,
    type,
    data,
    ts: '2026-01-01T00:00:00Z',
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    actor: { id: 'owner', org: '', role: '', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
    ...extra,
  }) as EventEnvelope
const callId = '00000000-0000-4000-8000-000000000001'
const candidateId = 'candidate-' + 'a'.repeat(32)
const params: FactChainParams = { sessionId: 'owned', laneId: 'main', anchor: { kind: 'request', callId } }
const scan =
  (events: EventEnvelope[]) =>
  async (q: { type?: string | string[]; lane?: string; toSeq?: number; limit?: number }) =>
    events
      .filter(
        (row) =>
          (!q.type || (Array.isArray(q.type) ? q.type.includes(row.type) : q.type === row.type)) &&
          (!q.lane || row.lane === q.lane) &&
          row.seq <= (q.toSeq ?? Infinity),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, q.limit)
const request = {
  id: `request:${callId}`,
  kind: 'request' as const,
  callId,
  seq: null,
  model: 'demo',
  generationId: '00000000-0000-4000-8000-000000000002',
  derivedHash: 'a'.repeat(64),
  promptHash: 'b'.repeat(64),
  toolSchemaHash: 'c'.repeat(64),
  messagesHash: 'd'.repeat(64),
  memoryRevision: null,
  memoryHash: null,
  hashBasis: 'redacted-json' as const,
  incomplete: false,
}
function endpoint() {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  return ep
}
async function rpc(ep: LocalEndpoint, input = params) {
  return (await ep.handle({
    jsonrpc: '2.0',
    id: 1,
    method: '_agnes/v1/session.factChain',
    params: input,
  })) as { result?: FactChainResult; error?: { data?: { code?: string } } }
}
const owner = (_method: string, id: string) => {
  if (id !== 'owned') throw rpcError('CAPABILITY_DENIED')
}

it('checks ownership before reading any source, and anchor membership before capture or package metadata', async () => {
  const ep = endpoint()
  registerFactChain(ep, {
    requireSessionOwner: owner,
    scan: () => scan([row(1, 'request/sent', { requestTraceId: callId })]),
    traces: {
      metadata: async () => {
        throw new Error('Foreign content must never be read')
      },
    },
    binding: () => {
      throw new Error('Foreign binding must never be read')
    },
  })
  expect((await rpc(ep, { ...params, sessionId: 'foreign' })).error?.data?.code).toBe('CAPABILITY_DENIED')
  expect((await rpc(ep, { ...params, laneId: 'foreign' })).result).toMatchObject({
    nodes: [],
    gaps: [{ at: null, reason: 'source-unavailable' }],
  })
  expect(
    (
      await rpc(ep, {
        ...params,
        anchor: { kind: 'request', callId: '00000000-0000-4000-8000-000000000099' },
      })
    ).result?.nodes,
  ).toEqual([])
})

it('uses capture-time generation and metadata, preserving absent capture and historical source gaps', async () => {
  const ep = endpoint()
  registerFactChain(ep, {
    requireSessionOwner: owner,
    scan: () => scan([row(2, 'request/sent', { requestTraceId: callId, derived_hash: 'f'.repeat(64) })]),
    traces: {
      metadata: async () => ({
        request,
        attempts: [
          {
            id: 'attempt:real',
            kind: 'attempt',
            attemptId: 'real',
            parentCallId: callId,
            index: 0,
            adapterId: 'demo',
            status: 'completed',
            wireUnavailable: 'adapter-no-tap',
          },
        ],
      }),
    },
    binding: (_id, generationId) => {
      expect(generationId).toBe(request.generationId)
      return [
        {
          id: `generation:${generationId}`,
          kind: 'generation',
          generationId: generationId!,
          packages: [
            {
              packageId: 'plugin',
              version: '1.0.0',
              snapshotId: 'historic',
              integrity: 'sha256-old',
              treeIntegrity: 'sha256-old-tree',
            },
          ],
        },
      ]
    },
  })
  const result = (await rpc(ep)).result!
  expect(result.nodes.find((node) => node.kind === 'request')).toMatchObject({
    hashBasis: 'redacted-json',
    derivedHash: request.derivedHash,
    seq: 2,
  })
  expect(result.nodes.find((node) => node.kind === 'generation')).toMatchObject({
    generationId: request.generationId,
    packages: [{ version: '1.0.0' }],
  })
  expect(result.gaps).toContainEqual({ at: 'attempt:real', reason: 'capture-unavailable' })
  expect(result.gaps).not.toContainEqual({ at: request.id, reason: 'capture-unavailable' })
  const missing = endpoint()
  registerFactChain(missing, {
    requireSessionOwner: owner,
    scan: () => scan([row(2, 'request/sent', { requestTraceId: callId })]),
    traces: { metadata: async () => null },
  })
  expect((await rpc(missing)).result?.gaps).toContainEqual({ at: request.id, reason: 'not-retained' })
})

it('checks the candidate owner and exact drafting session before revealing tests, hashes or review state', async () => {
  const candidate = {
    candidateId,
    packageId: 'plugin',
    candidateHash: 'sha256-' + 'a'.repeat(64),
    baseHash: null,
    reviewHash: 'sha256-' + 'b'.repeat(64),
    state: 'published',
    origin: { sessionKey: 'owned', toolUseId: 'draft', turn: 1 },
    preview: { version: '1.0.0' },
    tests: { hash: 'sha256-' + 'b'.repeat(64), state: 'passed', count: 1 },
    reviewer: 'private-reviewer',
  } as AuthoringCandidate
  const make = (value: AuthoringCandidate) => {
    const ep = endpoint()
    registerFactChain(ep, {
      requireSessionOwner: owner,
      scan: () => scan([row(1, 'tool/call', { toolUseId: 'draft', name: 'plugin_manage' })]),
      candidate: async () => value,
    })
    return ep
  }
  const input: FactChainParams = { ...params, anchor: { kind: 'authoring', candidateId } }
  const result = (await rpc(make(candidate), input)).result!
  expect(result.nodes.find((node) => node.kind === 'authoring')).toMatchObject({
    testsState: null,
    testsCount: 0,
    reviewed: false,
  })
  expect(JSON.stringify(result)).not.toContain('private-reviewer')
  const denied = await rpc(
    make({ ...candidate, origin: { ...candidate.origin, sessionKey: 'foreign' } }),
    input,
  )
  expect(denied.result).toMatchObject({ nodes: [], gaps: [{ at: null, reason: 'source-unavailable' }] })
  expect(JSON.stringify(denied)).not.toContain(candidate.candidateHash)
})

it('bounds long ledgers, fixes the watermark and reports truncation instead of claiming completeness', async () => {
  const ep = endpoint()
  const events = Array.from({ length: 2200 }, (_, index) =>
    row(index + 1, 'tool/call', { toolUseId: `tool-${index}`, name: 'read' }),
  )
  registerFactChain(ep, { requireSessionOwner: owner, scan: () => scan(events) })
  const result = (await rpc(ep, { ...params, anchor: { kind: 'tool', toolUseId: 'tool-2199' } })).result!
  expect(result.atSeq).toBe(2200)
  expect(result.nodes.length).toBeLessThanOrEqual(256)
  expect(result.gaps).toContainEqual({ at: null, reason: 'truncated' })
})

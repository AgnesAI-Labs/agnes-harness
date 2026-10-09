import type { EventEnvelope, FactChainResult } from '@agnes/protocol'
import { validateMethod } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { projectFactChain } from '../src/project/fact-chain.js'

const row = (seq: number, type: string, data: unknown, extra: Partial<EventEnvelope> = {}): EventEnvelope =>
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
const call = row(1, 'tool/call', { toolUseId: 't1', name: 'write_file', args: { password: 'private-input' } })
const ref = { sha256: 'a'.repeat(64), size: 7, mime: 'text/plain' }
const project = (
  events: EventEnvelope[],
  anchor: Parameters<typeof projectFactChain>[0]['anchor'] = { kind: 'tool', toolUseId: 't1' },
) => projectFactChain({ sessionId: 'owned', laneId: 'main', anchor, atSeq: 100, events })
const receipt = (result: FactChainResult) => result.nodes.find((node) => node.kind === 'receipt')

it('keeps error, cancellation, uncertain recovery and deferred acceptance distinct without claiming external completion', () => {
  for (const [code, isError, outcome, kind] of [
    [undefined, false, 'ok', 'actual'],
    ['FAILURE', true, 'error', 'actual'],
    ['CANCELLED', true, 'aborted', 'synthetic'],
    ['TOOL_OUTCOME_UNKNOWN', true, 'unknown', 'synthetic'],
  ] as const) {
    const result = project([
      call,
      row(
        2,
        'tool/result',
        {
          toolUseId: 't1',
          isError,
          ...(code ? { code } : {}),
          content: [{ type: 'text', text: 'private-output' }],
          partial: code === 'CANCELLED',
        },
        { sourceEventSeqs: [1] },
      ),
    ])
    expect(receipt(result)).toMatchObject({ outcome, resultKind: kind, externalOutcome: 'unknown' })
    expect(JSON.stringify(result)).not.toMatch(/private-input|private-output|password/)
    expect(validateMethod('_agnes/v1/session.factChain', 'result', result).ok).toBe(true)
  }
  const deferred = project([call, row(2, 'x/core/deferred-job', { toolUseId: 't1', jobId: 'j1' })])
  expect(receipt(deferred)).toMatchObject({
    outcome: 'unknown',
    resultKind: 'deferred-accepted',
    resultSeq: null,
  })
  expect(receipt(project([call]))).toMatchObject({ outcome: 'unknown', resultKind: 'unavailable' })
  expect(project([call]).edges[0]?.relation).toBe('status')
})

it('accepts only explicit identities and full artifact references, with no time, digest or extension-origin inference', () => {
  const events = [
    call,
    row(2, 'tool/result', { toolUseId: 't1', content: [] }, { sourceEventSeqs: [1] }),
    row(3, 'artifact/job', { jobId: 'j1', status: 'done', ref }, { sourceEventSeqs: [2] }),
    row(4, 'artifact/job', { jobId: 'j2', status: 'done', ref }),
    row(
      5,
      'x/core/loop-effect',
      { toolUseId: 't1', invocationId: 'forged' },
      { origin: 'ext:bad', trust: 'untrusted' },
    ),
  ]
  const result = project(events)
  expect(result.nodes.find((node) => node.kind === 'invocation')).toMatchObject({ invocationId: null })
  expect(result.nodes.filter((node) => node.kind === 'artifact')).toHaveLength(1)
  expect(result.edges.find((edge) => edge.relation === 'produced')).toMatchObject({ evidence: [2, 3] })
  expect(project(events, { kind: 'artifact', seq: 4, ref }).nodes).toHaveLength(1)
  expect(project(events, { kind: 'artifact', seq: 3, ref: { ...ref, size: 8 } }).nodes).toEqual([])
  expect(
    project([row(1, 'tool/call', { toolUseId: 't1', name: 'other' }, { lane: 'foreign' })]).nodes,
  ).toEqual([])
  expect(result.gaps).toContainEqual({ at: 'tool:main:t1', reason: 'ambiguous-link' })
  const reused = project([...events, row(6, 'tool/call', { toolUseId: 't1', name: 'write_file', args: {} })])
  expect(reused.nodes).toEqual([])
  expect(reused.gaps).toContainEqual({ at: null, reason: 'ambiguous-link' })
})

it('links full tool-result references by their exact result sequence and reports reference truncation', () => {
  const events = [
    call,
    row(
      2,
      'tool/result',
      {
        toolUseId: 't1',
        content: [],
        artifactRefs: [ref, { ...ref, mime: 'text/markdown' }],
        artifactRefsTruncated: true,
      },
      { sourceEventSeqs: [1] },
    ),
  ]
  const result = project(events, { kind: 'artifact', seq: 2, ref })
  expect(result.nodes.find((node) => node.kind === 'artifact')).toMatchObject({
    seq: 2,
    relation: 'produced',
  })
  expect(result.edges.find((edge) => edge.relation === 'produced')).toMatchObject({ evidence: [1, 2] })
  expect(result.gaps).toContainEqual({ at: 'tool:main:t1', reason: 'truncated' })
  expect(result.nodes.filter((node) => node.kind === 'artifact')).toHaveLength(2)
  expect(project(events, { kind: 'artifact', seq: 1, ref }).nodes).toEqual([])
})

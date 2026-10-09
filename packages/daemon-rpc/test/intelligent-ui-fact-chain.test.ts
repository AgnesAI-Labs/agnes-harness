import { expect, it } from 'vitest'
import type { EventEnvelope, FactChainResult } from '@agnes/protocol'
import { appendIntelligentUiFactChain } from '../src/local/methods/intelligent-ui-fact-chain.js'

const fact = (seq: number, name: string, data: unknown, origin = 'ext:agnes/intelligent-ui') =>
  ({ seq, type: 'x/agnes/intelligent-ui/' + name, data, lane: 'main', origin }) as EventEnvelope
it('links review revisions and action outcomes only to their original tool invocation', () => {
  const result = {
    sessionId: 's',
    laneId: 'main',
    atSeq: 10,
    nodes: [{ id: 'tool:main:t', kind: 'invocation', invocationId: 'ui:bound', callSeq: 4 }],
    edges: [],
    gaps: [],
  } as unknown as FactChainResult
  const rows = [
    fact(1, 'surface.opened', { record: { surface: { id: 'review', revision: 1, title: 'Review' } } }),
    fact(2, 'action.received', {
      sourceSeq: 1,
      record: {
        request: { surfaceId: 'review', revision: 1, commandId: 'confirm' },
        surfaceSeq: 1,
        invocation: { id: 'ui:bound' },
      },
    }),
    fact(5, 'action.succeeded', { sourceSeq: 2, commandId: 'confirm', receipt: { status: 'succeeded' } }),
    fact(6, 'surface.updated', {
      sourceSeq: 1,
      record: { surface: { id: 'review', revision: 2, title: 'Review' } },
    }),
    fact(7, 'surface.opened', { record: { surface: { id: 'unrelated', revision: 1, title: 'Other' } } }),
    fact(
      8,
      'action.received',
      {
        record: {
          request: { surfaceId: 'review', revision: 1, commandId: 'forged' },
          invocation: { id: 'ui:bound' },
        },
      },
      'model',
    ),
  ]
  appendIntelligentUiFactChain(result, rows)
  expect(result.nodes.filter((node) => node.kind === 'plugin-fact').map((node) => node.seq)).toEqual([
    1, 2, 5, 6,
  ])
  expect(result.edges).toContainEqual({
    from: 'ui-fact:main:2',
    to: 'tool:main:t',
    relation: 'dispatched',
    evidence: [2, 4],
    basis: 'ledger',
  })
  expect(result.gaps).toEqual([])
})
it('reports missing review references rather than guessing a nearby surface', () => {
  const result = {
    sessionId: 's',
    laneId: 'main',
    atSeq: 10,
    nodes: [{ id: 'tool:main:t', kind: 'invocation', invocationId: 'ui:bound', callSeq: 4 }],
    edges: [],
    gaps: [],
  } as unknown as FactChainResult
  appendIntelligentUiFactChain(result, [
    fact(2, 'action.received', {
      sourceSeq: 1,
      record: {
        request: { surfaceId: 'review', revision: 1, commandId: 'confirm' },
        surfaceSeq: 1,
        invocation: { id: 'ui:bound' },
      },
    }),
  ])
  expect(result.gaps).toContainEqual({ at: 'ui-fact:main:2', reason: 'source-unavailable' })
})

import { expect, it } from 'vitest'
import type { EventEnvelope, UITurn } from '@agnes/protocol'
import { appendUiTrace } from '../src/runtime/sessions/intelligent-ui-trace.js'

it('decorates trace revisions and outcomes without changing cached turns or exposing form data', () => {
  const turn = {
    id: 'turn:1',
    startSeq: 1,
    endSeq: 20,
    trace: { id: 'root', children: [] },
  } as unknown as UITurn
  const rows = [
    {
      seq: 2,
      ts: '2026-10-09T00:00:00Z',
      origin: 'ext:agnes/intelligent-ui',
      type: 'x/agnes/intelligent-ui/surface.updated',
      data: {
        record: { surface: { title: 'Review', revision: 2, data: { secret: 'never include form data' } } },
      },
    },
    {
      seq: 3,
      ts: '2026-10-09T00:00:00Z',
      origin: 'ext:agnes/intelligent-ui',
      type: 'x/agnes/intelligent-ui/action.failed',
      data: { receipt: { revision: 2 } },
    },
    { seq: 4, origin: 'model', type: 'x/agnes/intelligent-ui/action.succeeded', data: {} },
    {
      seq: 30,
      origin: 'ext:agnes/intelligent-ui',
      type: 'x/agnes/intelligent-ui/action.succeeded',
      data: {},
    },
  ] as EventEnvelope[]
  const result = appendUiTrace([turn], rows)
  expect(result[0]!.trace!.children.map((span) => [span.name, span.status])).toEqual([
    ['surface.updated · r2 · Review', 'completed'],
    ['action.failed · r2', 'failed'],
  ])
  expect(turn.trace!.children).toEqual([])
  expect(JSON.stringify(result)).not.toContain('never include form data')
})

import type { McpStatus } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { createMcpStatusFrameBuffer } from '../src/status-frame-buffer.js'

const status = (
  serverId: string,
  connectionState: McpStatus['connectionState'] = 'connecting',
): McpStatus => ({
  serverId,
  connectionState,
  observedRevision: null,
  catalogRevision: null,
  toolCount: 0,
  observedAt: new Date(0).toISOString(),
})

describe('createMcpStatusFrameBuffer', () => {
  it('queues every report before open() instead of sending it', () => {
    const sent: unknown[] = []
    const buffer = createMcpStatusFrameBuffer((frame) => sent.push(frame))
    buffer.report('a', status('a'))
    buffer.report('b', status('b', 'ready'))
    expect(sent).toEqual([])
  })

  it('open() sends every queued report in the order it was reported, then stops buffering', () => {
    const sent: unknown[] = []
    const buffer = createMcpStatusFrameBuffer((frame) => sent.push(frame))
    buffer.report('a', status('a'))
    buffer.report('b', status('b', 'ready'))
    buffer.open()
    expect(sent).toEqual([
      { kind: 'resourceStatus', serverId: 'a', status: status('a') },
      { kind: 'resourceStatus', serverId: 'b', status: status('b', 'ready') },
    ])

    buffer.report('c', status('c', 'unavailable'))
    expect(sent).toEqual([
      { kind: 'resourceStatus', serverId: 'a', status: status('a') },
      { kind: 'resourceStatus', serverId: 'b', status: status('b', 'ready') },
      { kind: 'resourceStatus', serverId: 'c', status: status('c', 'unavailable') },
    ])
  })

  it('a report after open() is never buffered, regardless of what happened before', () => {
    const sent: unknown[] = []
    const buffer = createMcpStatusFrameBuffer((frame) => sent.push(frame))
    buffer.open()
    buffer.report('a', status('a', 'ready'))
    expect(sent).toEqual([{ kind: 'resourceStatus', serverId: 'a', status: status('a', 'ready') }])
  })

  it('open() is idempotent: a second call never re-sends anything', () => {
    const sent: unknown[] = []
    const buffer = createMcpStatusFrameBuffer((frame) => sent.push(frame))
    buffer.report('a', status('a'))
    buffer.open()
    buffer.open()
    expect(sent).toHaveLength(1)
  })
})

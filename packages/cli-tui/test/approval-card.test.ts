import type { UINode } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { ApprovalCard } from '../src/views/approval-card.js'

type ApprovalNode = Extract<UINode, { kind: 'approval' }>

const node = (options: ApprovalNode['options']): ApprovalNode => ({
  kind: 'approval',
  id: 'approval-1',
  seq: 1,
  state: 'pending',
  summary: 'control the desktop',
  risk: 'always',
  options,
  ticket: 'ticket-1',
  expiresAt: '2026-09-17T23:59:00Z',
})

describe('ApprovalCard permanent grants', () => {
  it('renders and selects permanent only when that exact option was offered', async () => {
    const absent = new ApprovalCard(node(['allow_once', 'reject_once']), {
      ansi: createAnsi('none'),
      onDecide: vi.fn(async () => undefined),
    })
    expect(absent.render(100).join('\n')).not.toContain('Always allow for this profile')
    expect(absent.handleInput('3')).toBe(false)

    const decide = vi.fn(async () => undefined)
    const offered = new ApprovalCard(node(['allow_once', 'allow_permanent', 'reject_once']), {
      ansi: createAnsi('none'),
      onDecide: decide,
    })
    expect(offered.render(100).join('\n')).toContain('[2] Always allow for this profile')
    expect(offered.handleInput('2')).toBe(true)
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith('ticket-1', 'allowed-permanent'))
  })
})

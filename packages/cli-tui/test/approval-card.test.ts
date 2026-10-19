import type { UINode } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { TuiTheme } from '../src/theme.js'
import { ApprovalCard } from '../src/views/approval-card.js'

const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))

type ApprovalNode = Extract<UINode, { kind: 'approval' }>

const node = (options: ApprovalNode['options']): ApprovalNode => ({
  kind: 'approval',
  id: 'approval-1',
  seq: 1,
  state: 'pending',
  summary: 'control the desktop',
  risk: 'always',
  options,
  decisionRef: { sessionId: 's', id: 'ticket-1', revision: 1 },
  expiresAt: '2026-09-17T23:59:00Z',
})

describe('ApprovalCard permanent grants', () => {
  it('renders and selects permanent only when that exact option was offered', async () => {
    const absent = new ApprovalCard(node(['allow_once', 'reject_once']), {
      ansi: PLAIN,
      onDecide: vi.fn(async () => undefined),
    })
    expect(absent.render(100).join('\n')).not.toContain('Always allow for this profile')
    expect(absent.handleInput('3')).toBe(false)

    const decide = vi.fn(async () => undefined)
    const offered = new ApprovalCard(node(['allow_once', 'allow_permanent', 'reject_once']), {
      ansi: PLAIN,
      onDecide: decide,
    })
    expect(offered.render(100).join('\n')).toContain('[2] Always allow for this profile')
    expect(offered.handleInput('2')).toBe(true)
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        { sessionId: 's', id: 'ticket-1', revision: 1 },
        'allowed-permanent',
      ),
    )
  })
})

it('keeps the full single-line review subject readable before the choices', () => {
  const subjectText = 'x'.repeat(100000) + '<EXACT-TAIL>'
  const card = new ApprovalCard(
    { ...node(['allow_once', 'reject_once']), subjectText },
    {
      ansi: PLAIN,
      onDecide: async () => undefined,
    },
  )
  const lines = card.render(80)
  const subject = lines.slice(2, -1)
  expect(subject.every((line) => line.startsWith(' │ '))).toBe(true)
  expect(subject.map((line) => line.slice(3).trimEnd()).join('')).toBe(subjectText)
  expect(lines.at(-1)).toContain('[1]')
})

it('renders stopped authority distinctly from deadline expiry and offers no answer', () => {
  const card = new ApprovalCard(
    {
      ...node(['allow_once']),
      state: 'expired',
      decision: { verdict: 'allowed-once', via: 'human', reason: 'stopped' },
    },
    { ansi: PLAIN, onDecide: async () => undefined },
  )
  expect(card.render(80).join('')).toContain('stopped')
  expect(card.handleInput('1')).toBe(false)
})

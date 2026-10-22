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

describe('ApprovalCard prefix offer', () => {
  const prefixNode = {
    ...node(['allow_once', 'allow_always', 'reject_once']),
    prefixGrant: { tokens: ['git', 'push'], scope: 'shell:prefix:["git","push"]' },
  }

  it('renders the daemon tokens as given and answers with the prefix verdict', async () => {
    const decide = vi.fn(async () => undefined)
    const card = new ApprovalCard(prefixNode, { ansi: PLAIN, onDecide: decide })
    const text = card.render(140).join('\n')
    expect(text).toContain('[2] Allow commands starting with `git push` for this session')
    expect(card.handleInput('2')).toBe(true)
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        { sessionId: 's', id: 'ticket-1', revision: 1 },
        'allow_prefix_session',
      ),
    )
  })

  it('keeps ordinary approvals working next to an option kind it does not know', async () => {
    const decide = vi.fn(async () => undefined)
    const card = new ApprovalCard(
      node(['allow_once', 'allow_from_the_future', 'reject_once'] as unknown as ApprovalNode['options']),
      { ansi: PLAIN, onDecide: decide },
    )
    expect(card.render(100).join('\n')).not.toContain('undefined')
    expect(card.handleInput('2')).toBe(true)
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(expect.anything(), 'rejected'))
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

// The diff is a reading aid: a write may replace an existing file, and arguments beyond the diffed
// fields would otherwise be invisible, so the raw subject stays on the card under its own heading.
it('shows a write as a whole-file replacement and keeps the raw subject below the diff', () => {
  const subjectText = JSON.stringify({
    call: { name: 'write', args: { path: 'a.txt', content: 'hi', mode: 'x' } },
  })
  const text = new ApprovalCard(
    { ...node(['allow_once', 'reject_once']), subjectText },
    { ansi: PLAIN, onDecide: async () => undefined },
  )
    .render(400)
    .join('\n')
  expect(text).toContain('a.txt whole file, replaces it if it exists +1 -0')
  expect(text.indexOf('── Raw input ──')).toBeGreaterThan(text.indexOf('+ hi'))
  expect(text).toContain('"mode":"x"')
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

it('renders the selected locale fields without rewriting their exact meaning', () => {
  const card = new ApprovalCard(
    {
      ...node(['allow_once', 'reject_once']),
      presentation: {
        en: {
          title: 'Human signature',
          fields: [{ label: 'Meaning', value: 'I approve.' }],
          responseValue: 'I approve.',
        },
        'zh-CN': {
          title: '人工签署',
          fields: [{ label: '签名含义', value: '我批准。' }],
          responseValue: '我批准。',
        },
      },
    },
    { ansi: PLAIN, locale: 'zh-CN', onDecide: async () => undefined },
  )
  const text = card.render(100).join('\n')
  expect(text).toContain('人工签署')
  expect(text).toContain('签名含义: 我批准。')
  expect(text).not.toContain('Human signature')
})

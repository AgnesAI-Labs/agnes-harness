import type { UINode } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { ApprovalSettle } from '../src/approval-settle.js'
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
    expect(offered.render(100).join('\n')).toContain('[2] Always allow for this profile (a)')
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
    const card = new ApprovalCard(
      { ...prefixNode, prefixGrant: { ...prefixNode.prefixGrant, runsProjectCode: true } },
      { ansi: PLAIN, onDecide: decide },
    )
    const text = card.render(140).join('\n')
    expect(text).toContain('This also runs scripts defined in the project')
    expect(
      new ApprovalCard(prefixNode, { ansi: PLAIN, onDecide: decide }).render(140).join(''),
    ).not.toContain('This also runs scripts')
    expect(
      new ApprovalCard(
        { ...prefixNode, prefixGrant: { ...prefixNode.prefixGrant, runsProjectCode: true } },
        { ansi: PLAIN, locale: 'zh-CN', onDecide: decide },
      )
        .render(140)
        .join(''),
    ).toContain('这也会运行项目定义的脚本')
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

describe('ApprovalCard rejection reason', () => {
  const make = () => {
    const decide = vi.fn(async () => undefined)
    const card = new ApprovalCard(node(['allow_once', 'reject_once']), { ansi: PLAIN, onDecide: decide })
    return { card, decide }
  }
  const ref = { sessionId: 's', id: 'ticket-1', revision: 1 }
  const type = (card: ApprovalCard, text: string) => {
    for (const ch of text) card.handleInput(ch)
  }

  it('offers the reason key only next to a reject option', () => {
    expect(make().card.render(120).join('\n')).toContain('[r] Reject with a reason')
    const none = new ApprovalCard(node(['allow_once']), { ansi: PLAIN, onDecide: vi.fn() })
    expect(none.render(120).join('\n')).not.toContain('Reject with a reason')
    expect(none.handleInput('r')).toBe(false)
  })

  it('sends the typed words with the rejection on Enter', async () => {
    const { card, decide } = make()
    expect(card.handleInput('r')).toBe(true)
    type(card, 'no, usx')
    card.handleInput('\x7f')
    type(card, 'e staging')
    expect(card.render(120).join('\n')).toContain('no, use staging')
    expect(card.handleInput('\r')).toBe(true)
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(ref, 'rejected', 'no, use staging'))
  })

  it('goes back to the options on Esc and sends nothing', () => {
    const { card, decide } = make()
    card.handleInput('r')
    type(card, 'abc')
    expect(card.handleInput('\x1b')).toBe(true)
    expect(card.render(120).join('\n')).toContain('[1] Allow once')
    expect(decide).not.toHaveBeenCalled()
    expect(card.handleInput('1')).toBe(true)
  })

  it.each(['', '   '])('treats a blank reason (%j) as a plain rejection', async (blank) => {
    const { card, decide } = make()
    card.handleInput('r')
    type(card, blank)
    card.handleInput('\r')
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(ref, 'rejected'))
  })

  it('caps the reason at 500 characters, strips control characters and leaves ctrl-c alone', async () => {
    const { card, decide } = make()
    card.handleInput('r')
    expect(card.handleInput('\x03')).toBe(false)
    card.handleInput('\x1b[200~a\u0007b\n\x1b[31mc\x1b[201~')
    card.handleInput(`\x1b[200~${'x'.repeat(600)}\x1b[201~`)
    card.handleInput('\r')
    await vi.waitFor(() => expect(decide).toHaveBeenCalled())
    const sent = (decide.mock.calls[0] as unknown[])[2] as string
    expect([...sent]).toHaveLength(500)
    expect(sent.startsWith('a b ')).toBe(true)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(sent).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

describe('ApprovalCard facts', () => {
  const pending = (extra: Partial<ApprovalNode>) =>
    new ApprovalCard(
      { ...node(['allow_once', 'allow_permanent', 'reject_once']), ...extra },
      { ansi: PLAIN, onDecide: vi.fn() },
    )

  it('shows who asked and what an always-allow stores', () => {
    const text = pending({
      origin: { package: '@agnes/browser', role: 'reviewer', mcpServer: 'files' },
      grantScopes: ['tool:browser:execute', 'cua:click'],
    })
      .render(120)
      .join('\n')
    expect(text).toContain('from @agnes/browser · role reviewer · MCP server files')
    expect(text).toContain('Always allow stores: tool:browser:execute, cua:click')
  })

  it('shows neither line when the daemon sent neither, and strips control characters', () => {
    expect(pending({}).render(120).join('\n')).not.toMatch(/from |stores:/)
    const text = pending({ origin: { package: 'a\u001b[2Jb' }, grantScopes: ['s\u0007'] })
      .render(120)
      .join('\n')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u0007')
  })
})

describe('ApprovalCard single keys and the misclick guard', () => {
  const decide = () => vi.fn(async () => undefined)
  const ref = { sessionId: 's', id: 'ticket-1', revision: 1 }
  const card = (options: ApprovalNode['options'], onDecide = decide()) => ({
    onDecide,
    card: new ApprovalCard(node(options), { ansi: PLAIN, onDecide }),
  })

  it.each([
    ['y', 'allowed-once'],
    ['a', 'allowed-session'],
    ['n', 'rejected'],
  ])('%s decides %s once settled', async (key, verdict) => {
    const { card: c, onDecide } = card(['allow_once', 'allow_always', 'allow_permanent', 'reject_once'])
    expect(c.handleInput(key, true)).toBe(true)
    await vi.waitFor(() => expect(onDecide).toHaveBeenCalledWith(ref, verdict))
  })

  it('a takes the first persistent scope listed, and does nothing when there is none', async () => {
    const first = card(['allow_once', 'allow_permanent', 'allow_always', 'reject_once'])
    first.card.handleInput('a')
    await vi.waitFor(() => expect(first.onDecide).toHaveBeenCalledWith(ref, 'allowed-permanent'))
    const none = card(['allow_once', 'reject_once'])
    expect(none.card.handleInput('a')).toBe(true)
    expect(none.onDecide).not.toHaveBeenCalled()
  })

  it('decides nothing before the card has settled, and leaves the keys to the prompt draft', () => {
    const { card: c, onDecide } = card(['allow_once', 'allow_always', 'reject_once'])
    for (const key of ['y', 'a', 'n', '1', '2', '3', 'r']) expect(c.handleInput(key, false)).toBe(false)
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('dims the hints until settled and lists the letters beside the numbers', () => {
    let lit = false
    const c = new ApprovalCard(node(['allow_once', 'allow_always', 'reject_once']), {
      ansi: new TuiTheme('dark').ansi(createAnsi('truecolor')),
      onDecide: decide(),
      settled: () => lit,
    })
    const row = () => c.render(100).at(-1) ?? ''
    const dim = row()
    expect(dim).toContain('Allow once (y)')
    expect(dim).toContain('Allow for this session (a)')
    expect(dim).toContain('Reject (n)')
    lit = true
    expect(row()).not.toBe(dim)
  })
})

describe('ApprovalSettle', () => {
  it('settles after the quiet period, restarts on every key and on a different approval', () => {
    vi.useFakeTimers()
    try {
      let id: string | undefined = 'one'
      const repaint = vi.fn()
      const settle = new ApprovalSettle(repaint, () => id, 600)
      settle.watch()
      expect(settle.settled).toBe(false)
      vi.advanceTimersByTime(606)
      expect(repaint).toHaveBeenCalledTimes(1)
      expect(settle.settled).toBe(true)
      expect(settle.press()).toBe(true)
      vi.advanceTimersByTime(300)
      expect(settle.press()).toBe(false)
      vi.advanceTimersByTime(599)
      expect(settle.press()).toBe(false)
      vi.advanceTimersByTime(601)
      expect(settle.press()).toBe(true)
      id = 'two'
      expect(settle.press()).toBe(false)
      id = undefined
      settle.watch()
      settle.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

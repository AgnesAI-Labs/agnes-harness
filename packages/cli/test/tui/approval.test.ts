import type { UINode, UITimeline } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { ApprovalCard } from '../../src/tui/views/approval-card.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const A = createAnsi('none')

type ApprovalNode = Extract<UINode, { kind: 'approval' }>

// The real `UINode` (kind: 'approval') shape (packages/protocol/gen/ts/agnes-v1.ts) is flat --
// `ticket` / `expiresAt` / `state` / `decision.verdict` sit directly on the node -- not the nested
// `approval.pending` / `approval.decided` shape an earlier illustrative plan draft assumed.
const node = (over: Partial<ApprovalNode> = {}): ApprovalNode => ({
  kind: 'approval',
  id: 'ap1',
  seq: 9,
  state: 'pending',
  summary: 'shell rm -rf tmp',
  risk: 'destructive',
  options: ['allow_once', 'allow_always', 'reject_once'],
  ...over,
})

describe('ApprovalCard: the persisted approval projection (distinct from the live PermissionModal)', () => {
  it('parked path (a real ticket): shows ticket/expiry and decides on keypress', async () => {
    const decided: Array<[string, string]> = []
    const card = new ApprovalCard(node({ ticket: 'tk-abcdef123456', expiresAt: '2026-09-08T00:00:00Z' }), {
      ansi: A,
      onDecide: async (t, v) => {
        decided.push([t, v])
      },
    })
    const lines = card.render(60).join('\n')
    expect(lines).toContain('tk-abcde')
    expect(lines).toContain('2026-09-08T00:00:00Z')
    expect(lines).toContain('[1]')
    expect(lines).toContain('[3]')
    card.handleInput('1')
    await new Promise((r) => setTimeout(r, 0))
    expect(decided).toEqual([['tk-abcdef123456', 'allowed-once']])
    expect(card.render(60).join('\n')).toContain('allowed-once')
  })

  it('surfaces the real server rejection reason on decide failure, and shows no error on success', async () => {
    // Shape a rejected `_agnes/v1/approval.decide` call actually throws: sdk's JsonRpcError has
    // `.data.reason` (protocol's `rpcError('APPROVAL_REJECTED', { reason })` puts it there).
    const failing = new ApprovalCard(node({ ticket: 'tk-1', expiresAt: 'x' }), {
      ansi: A,
      onDecide: async () => {
        throw Object.assign(new Error('APPROVAL_REJECTED (-32009)'), {
          code: -32009,
          data: { code: 'APPROVAL_REJECTED', reason: 'self-approval' },
        })
      },
    })
    failing.handleInput('2')
    await new Promise((r) => setTimeout(r, 0))
    expect(failing.render(60).join('\n')).toContain('self-approval')

    const succeeding = new ApprovalCard(node({ ticket: 'tk-2', expiresAt: 'x' }), {
      ansi: A,
      onDecide: async () => {},
    })
    succeeding.handleInput('3')
    await new Promise((r) => setTimeout(r, 0))
    const out = succeeding.render(60).join('\n')
    expect(out).not.toContain('self-approval')
    expect(out).not.toContain('✗')
  })

  it('a decided node renders as a single line -- never through the pending branch', () => {
    const card = new ApprovalCard(
      node({ state: 'decided', decision: { verdict: 'rejected', via: 'local' } }),
      {
        ansi: A,
        onDecide: async () => {},
      },
    )
    const out = card.render(60)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('rejected')
    expect(out[0]).not.toContain('[1]')
    // decided nodes are inert: no ticket to decide against, and the phase is already terminal
    expect(card.handleInput('1')).toBe(false)
  })

  it('a genuinely pending+parked node renders through the pending branch -- never the decided one', () => {
    const card = new ApprovalCard(node({ ticket: 'tk-3', expiresAt: 'x' }), {
      ansi: A,
      onDecide: async () => {},
    })
    const out = card.render(60).join('\n')
    expect(out).toContain('[1]')
    expect(out).toContain('[2]')
    expect(out).toContain('[3]')
    expect(out).not.toContain('✓')
    expect(out).not.toContain('✗')
  })

  it('localizes the fixed parked-approval copy while preserving the projected summary', () => {
    const card = new ApprovalCard(node({ ticket: 'tk-3', expiresAt: 'x' }), {
      ansi: A,
      locale: 'zh-CN',
      onDecide: async () => {},
    })
    const out = card.render(80).join('\n')
    expect(out).toContain('等待审批: shell rm -rf tmp')
    expect(out).toContain('[1] 允许一次')
    expect(out).toContain('[2] 本会话允许')
    expect(out).toContain('[3] 拒绝')
  })

  it('colors the verdict glyph by outcome on a colour tier', () => {
    const ansi = createAnsi('256')
    const decided = new ApprovalCard(
      node({ state: 'decided', decision: { verdict: 'allowed-once', via: 'local' } }),
      { ansi, onDecide: async () => {} },
    )
    expect(decided.render(60)[0]).toContain('\x1b[38;5;78m✓\x1b[39m')
    const expired = new ApprovalCard(node({ state: 'expired', ticket: 'tk-9', expiresAt: 'x' }), {
      ansi,
      onDecide: async () => {},
    })
    expect(expired.render(60)[0]).toContain('\x1b[38;5;203m✗\x1b[39m')
    const pending = new ApprovalCard(node({ ticket: 'tk-8', expiresAt: 'x' }), {
      ansi,
      onDecide: async () => {},
    })
    expect(pending.render(60)[0]).toContain('\x1b[38;5;178m⚠\x1b[39m')
    // none tier: the very same cards emit zero escape sequences.
    const plain = new ApprovalCard(
      node({ state: 'decided', decision: { verdict: 'rejected', via: 'local' } }),
      {
        ansi: A,
        onDecide: async () => {},
      },
    )
    expect(plain.render(60).join('\n')).not.toContain('\x1b')
  })

  it('sync path (pending, no ticket): only the summary shows -- the dialog belongs to PermissionModal', () => {
    const card = new ApprovalCard(node(), { ansi: A, onDecide: async () => {} })
    const out = card.render(60).join('\n')
    expect(out).toContain('shell rm -rf tmp')
    expect(out).not.toContain('[1]')
    expect(card.render(60)).toHaveLength(1)
    expect(card.handleInput('1')).toBe(false)
  })

  it('an expired node renders a single terminal line and takes no input', () => {
    const card = new ApprovalCard(node({ state: 'expired', ticket: 'tk-4', expiresAt: 'x' }), {
      ansi: A,
      onDecide: async () => {},
    })
    const out = card.render(60)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('expired')
    expect(card.handleInput('1')).toBe(false)
  })

  it('only offered options get a key: an option missing from n.options is never actionable', async () => {
    const decided: Array<[string, string]> = []
    const card = new ApprovalCard(node({ ticket: 'tk-5', expiresAt: 'x', options: ['allow_once'] }), {
      ansi: A,
      onDecide: async (t, v) => {
        decided.push([t, v])
      },
    })
    const out = card.render(60).join('\n')
    expect(out).toContain('[1]')
    expect(out).not.toContain('[2]')
    expect(card.handleInput('2')).toBe(false)
    card.handleInput('1')
    await new Promise((r) => setTimeout(r, 0))
    expect(decided).toEqual([['tk-5', 'allowed-once']])
  })
})

// --- Wiring-level: the real `TuiApp` dispatch (app.ts's `nodeView`/`handleInput`), not just the
// isolated `ApprovalCard` class. Drives real keystrokes through a real `TuiApp` over a real
// `@agnes/sdk` `Client`/`Session`, against a `FakeEndpoint` that serves a fixed `_agnes/v1/
// session.projectUI` result (a real daemon's core-side projection reducer is out of scope for cli;
// what this proves is that app.ts really calls `_agnes/v1/approval.decide` with `{ ticket, verdict,
// approverCredential }` and that a rejection really reaches the screen through the real render loop
// -- not a hand-wired assertion against the component alone).
const FAKE_SID = 'agnes:local:default:cli:dm:main'

async function appOnApprovalNode(
  n: ApprovalNode,
  decide: (params: unknown) => unknown,
): Promise<{ app: TuiApp; term: FakeTerminal; ep: FakeEndpoint; client: ReturnType<typeof createClient> }> {
  const timeline: UITimeline = {
    sessionId: FAKE_SID,
    upto: n.seq,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [n],
  }
  const ep = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: FAKE_SID }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: n.seq, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.projectUI', () => timeline)
    .on('_agnes/v1/approval.decide', decide)
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 60, rows: 12 })
  const app = new TuiApp({ term, session, header: 'Agnes' })
  await app.start()
  return { app, term, ep, client }
}

describe('ApprovalCard wired into the real TuiApp (app.ts nodeView / handleInput)', () => {
  it('a real keypress calls the real wire method with { ticket, verdict, approverCredential }', async () => {
    const { app, term, ep, client } = await appOnApprovalNode(
      node({ ticket: 'tk-wire-1', expiresAt: '2026-09-10T00:00:00Z' }),
      () => ({ seq: 1 }),
    )
    try {
      await vi.waitFor(async () =>
        expect((await screenOf(term, 60, 12)).join('\n')).toContain('tk-wire-1'.slice(0, 8)),
      )
      term.feed('1')
      await vi.waitFor(() =>
        expect(ep.calls.some((c) => c.method === '_agnes/v1/approval.decide')).toBe(true),
      )
      const call = ep.calls.find((c) => c.method === '_agnes/v1/approval.decide')
      expect(call?.params).toEqual({
        ticket: 'tk-wire-1',
        verdict: 'allowed-once',
        approverCredential: { kind: 'local' },
      })
      await vi.waitFor(async () =>
        expect((await screenOf(term, 60, 12)).join('\n')).toContain('allowed-once'),
      )
      // A real, successful decide over the real app never leaves an error mark behind.
      expect((await screenOf(term, 60, 12)).join('\n')).not.toContain('✗')
    } finally {
      await app.stop()
      await client.close()
      await ep.close()
    }
  })

  it('a real rejection from the wire surfaces its reason on screen through the real render loop', async () => {
    const { app, term, client, ep } = await appOnApprovalNode(
      node({ ticket: 'tk-wire-2', expiresAt: 'x' }),
      () => {
        throw Object.assign(new Error('APPROVAL_REJECTED (-32009)'), {
          code: -32009,
          data: { code: 'APPROVAL_REJECTED', reason: 'ticket expired' },
        })
      },
    )
    try {
      await vi.waitFor(async () => expect((await screenOf(term, 60, 12)).join('\n')).toContain('[2]'))
      const before = (await screenOf(term, 60, 12)).join('\n')
      expect(before).not.toContain('ticket expired')
      term.feed('2')
      // This is exactly the regression the `changed()` callback exists to prevent: with no new
      // ledger event ever coming back for a rejected decide, nothing but that callback would ever
      // ask the renderer to look again, and this line would time out forever instead of passing.
      await vi.waitFor(async () =>
        expect((await screenOf(term, 60, 12)).join('\n')).toContain('ticket expired'),
      )
      const screen = (await screenOf(term, 60, 12)).join('\n')
      expect(screen).not.toContain('allowed-session')
    } finally {
      await app.stop()
      await client.close()
      await ep.close()
    }
  })
})

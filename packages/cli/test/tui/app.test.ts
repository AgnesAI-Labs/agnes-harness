import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import type { UINode, UITimeline } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import {
  createClient,
  inprocTransport,
  type JournalStore,
  type JsonRpcNotification,
  memoryJournal,
  type TransportFactory,
} from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { Timeline } from '../../src/tui/views/timeline.js'
import { ToolCard } from '../../src/tui/views/tool-card.js'
import { say, slowProvider } from '../boot-host.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { emulate, screenOf } from './harness.js'

it('keyboard input reaches real core through SDK/daemon and renders the projected answer in xterm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-app-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: [say('terminal answer\x1b]52;c;c2VjcmV0\x07'), say('next answer')],
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    const quit = vi.fn()
    app.onQuit = quit
    await app.start()
    expect(term.raw).toBe(true)
    term.feed('keyboard question')
    term.feed('\r')
    await vi.waitFor(async () => {
      const screen = (await screenOf(term, 80, 24)).join('\n')
      expect(screen).toContain('keyboard question')
      expect(screen).toContain('terminal answer')
    })
    expect(term.writes.join('')).not.toContain('\x1b]52;')
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    term.feed('second question')
    term.feed('\r')
    await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('next answer'))
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    term.feed('\x04')
    expect(quit).toHaveBeenCalledTimes(1)
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(0)
      term.feed('\x03')
      await Promise.resolve()
      expect(quit).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(1_001)
      term.feed('\x03')
      await Promise.resolve()
      expect(quit).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(2_001)
      term.feed('\x03')
      await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(2))
    } finally {
      clock.mockRestore()
    }
    await app.stop()
    expect(term.raw).toBe(false)
    expect(session.listeners.size).toBe(0)
    const writes = term.writes.length
    term.feed('after stop')
    expect(term.writes).toHaveLength(writes)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('renders localized daemon notices delivered through the real SDK Client event path', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:notices' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: 'agnes:local:default:cli:dm:notices',
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes', locale: 'zh-CN' })
  try {
    await app.start()
    endpoint.pushNotice({
      kind: 'resumed',
      sessionId: session.id,
      detail: { lastStep: 4 },
      at: new Date(0).toISOString(),
    })
    await vi.waitFor(async () =>
      expect((await screenOf(term, 80, 24)).join('\n')).toContain('上次停在第 4 步，已续跑'),
    )

    endpoint.pushNotice({
      kind: 'worker_crashed',
      sessionId: session.id,
      detail: {},
      at: new Date(0).toISOString(),
    })
    await vi.waitFor(async () =>
      expect((await screenOf(term, 80, 24)).join('\n')).toContain('执行中断，30 秒内自动恢复'),
    )
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
  }
})

it('opens a long restored session without replaying off-window history or fixed chrome into scrollback', async () => {
  const sessionId = 'agnes:local:default:cli:dm:long-opening'
  const nodes = Array.from({ length: 1_002 }, (_, index) => ({
    kind: 'user' as const,
    id: `user-${index + 1}`,
    seq: index + 1,
    content: [{ type: 'text' as const, text: `old history ${index + 1}` }],
  }))
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 1_002, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId,
      generation: 1,
      upto: 1_002,
      opState: null,
      nodes,
      turns: [],
    }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 50, rows: 12 })
  const app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
  try {
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 50, 12)).join('\n')).toContain('old history 1002'),
    )
    const screen = await emulate(term, 50, 12)
    expect(screen.scrollback.join('\n')).not.toContain('old history')
    expect(screen.scrollback.some((line) => line.startsWith('agnes ·'))).toBe(false)
    expect(screen.scrollback.join('\n')).not.toContain('Enter send')
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
  }
})

it('loads an earlier fixed-cut page on PgUp without moving the live attach cursor', async () => {
  const sessionId = 'agnes:local:default:cli:dm:paged-history'
  const user = (index: number) => ({
    kind: 'user' as const,
    id: `user-${index}`,
    seq: index,
    content: [{ type: 'text' as const, text: `history ${index}` }],
  })
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 10, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUIOpening', () => ({
      timeline: {
        sessionId,
        generation: 1,
        upto: 10,
        opState: null,
        turns: [],
        nodes: [user(8), user(9)],
      },
      history: { hasEarlier: true, cursor: 'before-8', startIndex: 8, totalNodes: 10 },
    }))
    .on('_agnes/v1/session.projectUIHistory', async () => {
      // Force at least one renderer turn before the page arrives, matching a real daemon roundtrip.
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        sessionId,
        generation: 1,
        cut: 10,
        turns: [],
        nodes: [user(4), user(5), user(6), user(7)],
        hasEarlier: true,
        cursor: 'before-4',
        startIndex: 4,
        totalNodes: 10,
      }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 50, rows: 10 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  try {
    await app.start()
    await vi.waitFor(async () => expect((await screenOf(term, 50, 10)).join('\n')).toContain('history 9'))
    term.feed('\x1b[5~')
    await vi.waitFor(() =>
      expect(
        endpoint.calls.filter((call) => call.method === '_agnes/v1/session.projectUIHistory'),
      ).toHaveLength(1),
    )
    await vi.waitFor(async () => expect((await screenOf(term, 50, 10)).join('\n')).toMatch(/history [4-7]/))
    const attach = endpoint.calls.filter((call) => call.method === '_agnes/v1/session.attach')
    expect(attach).toHaveLength(1)
    expect(attach[0]?.params).toMatchObject({ cursor: { fromSeq: 10, generation: 1 } })
    expect(
      endpoint.calls.filter((call) => call.method === '_agnes/v1/session.projectUIOpening'),
    ).toHaveLength(1)
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
  }
})

it('shows a stable error code without exposing the raw failure message', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:error' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => {
      throw rpcError('INTERNAL_ERROR', { code: 'E_PROJECTION_TEST', detail: 'secret backend detail' })
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  try {
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 80, 24)).join('\n')).toContain('Request failed (E_PROJECTION_TEST).'),
    )
    expect((await screenOf(term, 80, 24)).join('\n')).not.toContain('secret backend detail')
  } finally {
    await app.stop()
    await client.close()
  }
})

it('dispatches input queued while the prompt RPC is settling as the next real turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-queued-'))
  const { host } = await createTestHost({ dataDir: dir, provider: slowProvider(20) })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    app = new TuiApp({ session, term: new FakeTerminal({ columns: 80, rows: 24 }), header: 'Agnes' })
    await app.start()

    const first = app.submit('first prompt')
    expect(app.busy).toBe(true)
    await app.submit('second prompt')
    await first

    await vi.waitFor(async () => {
      const users = (await session.projectUI()).nodes
        .filter((node) => node.kind === 'user')
        .flatMap((node) => node.content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
      expect(users).toEqual(['first prompt', 'second prompt'])
    })
    await vi.waitFor(() => expect(app?.busy).toBe(false))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('Ctrl-C cancels actual core inference and restores an idle editor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-cancel-'))
  const { host } = await createTestHost({ dataDir: dir, provider: slowProvider(60_000) })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('slow question')
    term.feed('\r')
    await vi.waitFor(async () => expect((await session.projectUI()).opState).not.toBeNull())
    expect(app.busy).toBe(true)
    term.feed('\x03')
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    expect((await session.projectUI()).opState).toBeNull()
    expect((await screenOf(term, 80, 24)).join('\n')).not.toContain('too late')
    term.feed('new draft')
    await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('new draft'))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps long-conversation history inside fullscreen while paging the projected window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-history-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: [say(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n'))],
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 40, rows: 16 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await app.submit('long question')
    await vi.waitFor(async () => {
      const screen = await emulate(term, 40, 16)
      expect(screen.scrollback).toEqual([])
      expect(screen.lines, screen.lines.join('\n')).toContain('line 8')
    })
    const history = (await emulate(term, 40, 16)).scrollback
    // The unified usage node occupies several timeline rows. Allow room for it and the reply;
    // PgUp must reveal earlier conversation without writing to native scrollback.
    term.feed('\x1b[5~')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 1'))
    term.feed('\x1b[6~')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 8'))
    expect((await emulate(term, 40, 16)).scrollback).toEqual(history)
    await app.stop()
    const exited = await emulate(term, 40, 16)
    const shell = [...exited.scrollback, ...exited.lines].join('\n')
    expect(shell).not.toContain('long question')
    expect(shell).not.toContain('line 8')
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('renders actual projected Markdown with safe styles and literal user input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-markdown-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: [
      say(
        '# Answer\n\n**bold**\n\n- item\n\n```js\nlet x = 1\n```\n\n<b>raw</b> ![alt](https://invalid.example/img)\x1b]52;c;YQ==\x07',
      ),
    ],
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 40, rows: 40 }, { TERM: 'xterm' })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await app.submit('**literal question**')
    await vi.waitFor(async () => {
      const screen = await emulate(term, 40, 40)
      const lines = [...screen.scrollback, ...screen.lines].map((line) => line.trimEnd())
      expect(lines.some((line) => line.trimEnd() === '   › **literal question**')).toBe(true)
      expect(lines).toContain('Answer')
      expect(lines).toContain('bold')
      expect(lines).toContain('• item')
      expect(lines).toContain('  let x = 1')
      expect(lines).toContain('<b>raw</b> alt')
    })
    expect(term.writes.join('')).toContain('\x1b[1mbold\x1b[22m')
    expect(term.writes.join('')).not.toContain('\x1b]52;')
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps a tall draft cursor visible and submits all original lines through actual core', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-draft-'))
  const { host } = await createTestHost({ dataDir: dir, script: [say('accepted draft')] })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 30, rows: 12 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    const draft = Array.from({ length: 15 }, (_, i) => `draft ${i}`).join('\n')
    term.feed(draft)
    await vi.waitFor(async () => {
      const screen = await emulate(term, 30, 12)
      expect(screen.lines.some((line) => line.includes('draft 14'))).toBe(true)
      expect(screen.cursorHidden).toBe(false)
    })
    for (const _ of draft) term.feed('\x1b[D')
    await vi.waitFor(async () => {
      const screen = await emulate(term, 30, 12)
      expect(screen.lines.some((line) => line.includes('❯ draft 0'))).toBe(true)
      expect(screen.cursorHidden).toBe(false)
      expect(screen.lines[screen.cursor.row]).toContain('❯ draft 0')
    })
    term.feed('\r')
    await vi.waitFor(() => expect(app?.busy).toBe(false), { timeout: 10_000 })
    await vi.waitFor(async () => {
      const timeline = await session.projectUI()
      expect(timeline.nodes).toContainEqual(
        expect.objectContaining({ kind: 'assistant', text: 'accepted draft' }),
      )
    })
    const node = (await session.projectUI()).nodes.find((item) => item.kind === 'user')
    expect(node?.kind === 'user' && node.content).toEqual([{ type: 'text', text: draft }])
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

// Reverse-verification for the 2026-09-10 requestSeq ruling: `requestSeq` is a client-local
// counter minted fresh at the moment of a real click, never the value already sitting on
// `SlotFillView.requestSeq`. The wrong (rejected) implementation reads `s.requestSeq` off the
// slot fill itself, which never changes across re-renders -- so clicking the same action twice
// would send the *same* requestSeq both times, and the server's (requestSeq, action) idempotency
// check would silently swallow the second, genuinely-intended click. This test fails under that
// implementation and passes under the corrected one.
it("mints a fresh requestSeq for every real action click, never the slot fill's own requestSeq", async () => {
  const SID = 'agnes:local:default:cli:dm:main'
  const calls: Array<{ requestSeq: number; action: string; data?: unknown }> = []
  const timeline = {
    sessionId: SID,
    upto: 1,
    generation: 1,
    // A late historical projection may still advertise a running turn. It is display state, not
    // permission to trap the next editor submission in a local queue.
    opState: { turn: 7, step: 1, phase: 'tools' },
    turns: [],
    nodes: [
      {
        kind: 'tool',
        id: 't1',
        seq: 1,
        toolUseId: 'c1',
        name: 'query',
        status: 'completed',
        summary: '3 rows',
        slots: [
          {
            slot: 'tool.card.inline',
            extId: 'ext/x',
            // Deliberately stale and fixed: the rejected design echoed this field back as
            // requestSeq. A correct implementation never reads it.
            requestSeq: 99,
            payload: { title: 'sales', actions: [{ id: 'export', label: 'Export' }] },
          },
        ],
      },
    ],
  }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: SID }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline)
    .on('_agnes/v1/ext.ui.response', (params) => {
      calls.push(params as { requestSeq: number; action: string; data?: unknown })
      return { seq: calls.length }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    expect(app.busy).toBe(false)
    // `start()` renders an empty shell before its asynchronous projection returns. The projection
    // must schedule a second frame itself; no subsequent keystroke should be required to replace
    // an old running-tool frame with this completed card.
    await vi.waitFor(async () =>
      expect((await screenOf(term, 60, 20)).join('\n')).toContain('◆ query  3 rows'),
    )
    term.feed('\x0f') // Ctrl+O: expand the (only) tool card
    term.feed('1') // click action [1] "Export" -- first real click
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    term.feed('1') // click the very same action a second time -- second real click
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]?.requestSeq).not.toBe(calls[1]?.requestSeq)
    expect(calls[0]?.requestSeq).not.toBe(99)
    expect(calls[1]?.requestSeq).not.toBe(99)
    expect(
      calls.every((c) => c.action === 'accept' && (c.data as { id: string } | undefined)?.id === 'export'),
    ).toBe(true)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('shows contextual F1 actions only when projected and dispatches the selected action', async () => {
  const SID = 'agnes:local:default:cli:dm:hints'
  const calls: Array<{ requestSeq: number; action: string; data?: unknown }> = []
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: SID }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: SID,
      upto: 1,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        {
          kind: 'slot',
          id: 'hint-action',
          seq: 1,
          fill: {
            slot: 'sidebar.action',
            extId: 'ext/export',
            requestSeq: 88,
            payload: { id: 'export', label: 'Export report' },
          },
        },
      ],
    }))
    .on('_agnes/v1/ext.ui.response', (params) => {
      calls.push(params as { requestSeq: number; action: string; data?: unknown })
      return { seq: 2 }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 60, rows: 20 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  try {
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 60, 20)).join('\n')).toContain('F1 Export report'),
    )
    term.feed('\x1bOP')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ action: 'accept', data: { id: 'export' } })
    expect(calls[0]?.requestSeq).not.toBe(88)
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
  }
})

// TUI polish wiring (2026-09-11): the welcome banner, the editor divider and the role/prompt
// colours are asserted through the real TuiApp over a FakeEndpoint, so the tests exercise the
// actual construction in app.ts rather than the components in isolation.
const EMPTY_TIMELINE = {
  sessionId: 'agnes:local:default:cli:dm:main',
  upto: 0,
  generation: 1,
  opState: null,
  turns: [],
  nodes: [],
}

function fakeSessionEndpoint() {
  let sessions = 0
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: `agnes:local:default:cli:dm:s${++sessions}` }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 1 }))
    .on('_agnes/v1/session.projectUI', () => EMPTY_TIMELINE)
  return { endpoint, sessions: () => sessions }
}

it('keeps a pending approval at its usual page height when nothing below the dialog has grown', async () => {
  const { endpoint } = fakeSessionEndpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    // A server-initiated request; FakeEndpoint.push is typed for notifications but delivers any message.
    endpoint.push({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: session.id,
        toolCall: {
          toolCallId: 'tool-1',
          status: 'pending',
          title: 'write',
          rawInput: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, i])),
        },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    } as JsonRpcNotification)
    // 24 rows: the dialog keeps 24 - 24/3 - 4 = 12 rows, leaving 12 - 2 choices - 2 = 8 detail rows.
    await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('details 1-8/'))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it.each(['SESSION_BUSY', 'OVERLOADED'] as const)(
  'keeps a queued prompt the daemon refused with %s before admitting it, and sends it again',
  async (code) => {
    const { endpoint } = fakeSessionEndpoint()
    const prompts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    endpoint.on('session/prompt', async (params) => {
      prompts.push((params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? '')
      if (prompts.length === 1) await gate
      // Refused before the input is recorded (daemon acp.ts: activation barrier / another in-flight prompt).
      if (prompts.length === 2) throw rpcError(code, {})
      return { stopReason: 'end_turn' }
    })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    let app: TuiApp | undefined
    try {
      const session = await client.session.new({ cwd: '/tmp' })
      const term = new FakeTerminal({ columns: 80, rows: 24 })
      app = new TuiApp({ session, term, header: 'Agnes' })
      await app.start()
      term.feed('a')
      term.feed('\r')
      await vi.waitFor(() => expect(prompts).toEqual(['a']))
      term.feed('b')
      term.feed('\r')
      release()
      await vi.waitFor(() => expect(prompts).toEqual(['a', 'b', 'b']))
    } finally {
      await app?.stop()
      await client.close()
      await endpoint.close()
    }
  },
)

it('paints the startup session card, compact header and editor surface once across /new', async () => {
  const { endpoint, sessions } = fakeSessionEndpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard', model: 'deepseek-v4-pro' })
    await app.start()
    await vi.waitFor(async () => {
      const screen = await screenOf(term, 60, 20)
      const text = screen.join('\n')
      expect(text).toContain('Agnes AI ·ᴗ·')
      expect(text).toContain('local-dev · standard')
      expect(text).toContain('● deepseek-v4-pro')
      expect(text).toContain('输入 / 查看命令')
      expect(text).not.toContain('Ctrl+C×2 退出')
      // The header's first segment is the brand, separated from the profile.
      expect(text).toContain('agnes · local-dev · standard')
      expect(text).toContain('想做点什么？从一句话开始。')
    })
    term.feed('/new')
    term.feed('\r')
    await vi.waitFor(() => expect(sessions()).toBe(2))
    // The banner belongs to the app, not the session: the switch must not repaint it.
    await vi.waitFor(async () => expect((await screenOf(term, 60, 20)).join('\n')).toContain('li:dm:s2'))
    const text = (await screenOf(term, 60, 20)).join('\n')
    expect(text.split('Agnes AI').length - 1).toBe(1)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('uses the projected model in both empty-state card and composer when argv did not pin one', async () => {
  const projected = {
    ...EMPTY_TIMELINE,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      context: { tokens: 0, window: 262_144, autoCompact: true, source: 'estimated' as const },
      model: { route: 'account-kimi', id: 'kimi-for-coding-highspeed', thinking: 'off' as const },
    },
  }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: projected.sessionId }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => projected)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 100, rows: 20 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: '(default)' })
    await app.start()
    await vi.waitFor(async () => {
      const text = (await screenOf(term, 100, 20)).join('\n')
      expect(text.split('kimi-for-coding-highspeed').length - 1).toBe(2)
      expect(text).not.toContain('未选择模型')
      expect(text).not.toContain('正在解析模型')
    })
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('stacks the editor above the status footer without an idle shortcut legend', async () => {
  // A budget rides the projection so the status bar has visible, distinctive content to locate.
  // Above the 70% warning threshold (RP2), so the credits segment actually renders.
  const timeline = {
    ...EMPTY_TIMELINE,
    budget: { slot: 'primary', escalate: false, creditsUsed: 78, creditsCap: 100 },
  }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:main' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 60, 20)).some((l) => l.includes('credits 78/100'))).toBe(true),
    )
    const lines = await screenOf(term, 60, 20)
    const editorRow = lines.findIndex((l) => l.includes('❯'))
    const statusRow = lines.findIndex((l) => l.includes('credits 78/100'))
    // The quiet full-width frame owns its spacing and reserves the lower edge for model state.
    expect(lines[editorRow - 1]).toContain('╭')
    expect(lines[editorRow + 1]).toContain('╰')
    expect(statusRow).toBe(editorRow + 2)
    expect(lines.join('\n')).not.toContain('Enter send')
    const lastNonBlank = lines.reduce((last, l, i) => (l === '' ? last : i), -1)
    expect(statusRow).toBe(lastNonBlank)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('opens /model choices above the footer, switches primary once, and cancels without a write', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:model' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      ...EMPTY_TIMELINE,
      // Above the 70% warning threshold (RP2), so the credits segment used as a position anchor
      // below actually renders.
      budget: { slot: 'primary', escalate: false, creditsUsed: 3_000, creditsCap: 4_000 },
    }))
    .on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        models: [
          { route: 'deepseek', id: 'deepseek-v4-flash' },
          { route: 'deepseek', id: 'deepseek-v4-pro' },
        ],
      },
      families: [],
    }))
    .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 7 }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 70, rows: 24 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    term.feed('/model')
    term.feed('\r')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 70, 24)).join('\n')).toContain('deepseek/deepseek-v4-flash'),
    )
    const open = await screenOf(term, 70, 24)
    expect(open.findIndex((line) => line.includes('Select Model'))).toBeLessThan(
      open.findIndex((line) => line.includes('credits 3000/4000')),
    )

    term.feed('x') // The open picker owns unrelated keys too; this must not enter the editor.
    term.feed('\x1b[B')
    term.feed('\r')
    await vi.waitFor(() =>
      expect(endpoint.calls.filter((entry) => entry.method === '_agnes/v1/session.setModel')).toHaveLength(1),
    )
    expect(
      endpoint.calls.find((entry) => entry.method === '_agnes/v1/session.setModel')?.params,
    ).toMatchObject({
      slot: 'primary',
      route: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    await vi.waitFor(async () =>
      expect((await screenOf(term, 70, 24)).join('\n')).toContain(
        'model deepseek/deepseek-v4-pro from seq 7',
      ),
    )

    term.feed('/model')
    term.feed('\r')
    await vi.waitFor(async () => expect((await screenOf(term, 70, 24)).join('\n')).toContain('Select Model'))
    term.feed('\x1b')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 70, 24)).join('\n')).not.toContain('Select Model'),
    )
    expect(endpoint.calls.filter((entry) => entry.method === '_agnes/v1/session.setModel')).toHaveLength(1)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('opens /resume choices above the footer, owns input, loads the selection and replays history', async () => {
  const current = 'agnes:local:default:cli:session:current'
  const newer = 'agnes:local:default:cli:session:newer'
  const older = 'agnes:local:default:cli:session:older'
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: current }))
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 1, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.list', () => ({
      items: [
        {
          sessionId: current,
          createdAt: '2026-09-13T14:00:00Z',
          lastSeq: 0,
          generation: 1,
          preset: 'standard',
        },
        {
          sessionId: older,
          createdAt: '2026-09-11T12:00:00Z',
          lastSeq: 8,
          generation: 1,
          preset: 'standard',
          title: 'Older work',
        },
        {
          sessionId: newer,
          createdAt: '2026-09-12T12:00:00Z',
          lastSeq: 14,
          generation: 1,
          preset: 'claw',
          title: 'Newer work',
        },
      ],
    }))
    .on('_agnes/v1/session.projectUI', (params) => {
      const sessionId = (params as { sessionId?: string }).sessionId ?? current
      return {
        sessionId,
        upto: sessionId === older ? 1 : 0,
        generation: 1,
        opState: null,
        turns: [],
        nodes:
          sessionId === older
            ? [{ kind: 'assistant', id: 'history', seq: 1, text: 'restored older answer' }]
            : [],
        // Above the 70% warning threshold (RP2), so the credits segment used as a position anchor
        // below actually renders.
        budget: { slot: 'primary', escalate: false, creditsUsed: 3_000, creditsCap: 4_000 },
      }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 76, rows: 24 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()

    term.feed('/resume')
    term.feed('\r')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 76, 24)).join('\n')).toContain('Select Session'),
    )
    const open = await screenOf(term, 76, 24)
    expect(open.join('\n')).toContain('Newer work')
    expect(open.join('\n')).toContain('Older work')
    expect(open.findIndex((line) => line.includes('Select Session'))).toBeLessThan(
      open.findIndex((line) => line.includes('credits 3000/4000')),
    )
    expect(endpoint.calls.some((entry) => entry.method === 'session/load')).toBe(false)

    term.feed('x')
    term.feed('\x1b[B')
    term.feed('\r')
    await vi.waitFor(() =>
      expect(endpoint.calls.filter((entry) => entry.method === 'session/load')).toHaveLength(1),
    )
    expect(endpoint.calls.find((entry) => entry.method === 'session/load')?.params).toMatchObject({
      sessionId: older,
    })
    await vi.waitFor(async () =>
      expect((await screenOf(term, 76, 24)).join('\n')).toContain('restored older answer'),
    )
    expect((await screenOf(term, 76, 24)).find((line) => line.includes('❯'))).toContain(
      '❯ 想做点什么？从一句话开始。',
    )

    term.feed('/resume')
    term.feed('\r')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 76, 24)).join('\n')).toContain('Select Session'),
    )
    term.feed('\x1b')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 76, 24)).join('\n')).not.toContain('Select Session'),
    )
    expect(endpoint.calls.filter((entry) => entry.method === 'session/load')).toHaveLength(1)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('colors the user marker, prompt and slash-menu highlight on the light user-turn surface', async () => {
  const timeline = {
    ...EMPTY_TIMELINE,
    nodes: [{ kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'hello agnes' }] }],
  }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:main' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 1, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 }, { TERM: 'xterm-256color' })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    await vi.waitFor(async () => expect((await screenOf(term, 60, 20)).join('\n')).toContain('› hello agnes'))
    const out = term.writes.join('')
    // The prompt keeps its editor accent; the brand word consumes the resolved branding accent.
    expect(out).toContain('\x1b[38;5;98m❯ \x1b[38;5;238m')
    expect(out).toContain('\x1b[38;5;63magnes\x1b[38;5;238m')
    expect(out).toContain('\x1b[1m\x1b[38;5;63m›\x1b[38;5;238m\x1b[22m')
    expect(out).toContain('\x1b[48;5;254m')
    expect(out).not.toContain('\x1b[38;5;45myou:')
    term.feed('/')
    await vi.waitFor(() => expect(term.writes.join('')).toContain('\x1b[48;5;254m'))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('draws no transcript line at all for a context node', async () => {
  const timeline = {
    ...EMPTY_TIMELINE,
    nodes: [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'anchor line' }] },
      { kind: 'context', id: 'c1', seq: 2, text: '{"model":"x","cwd":"/repo"}' },
    ],
  }
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:main' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 2, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    // The user node is the anchor: once it is on screen the same projection has been drawn, so a
    // missing context line is a decision and not a frame that has not arrived yet.
    await vi.waitFor(async () => expect((await screenOf(term, 60, 20)).join('\n')).toContain('anchor line'))
    const screen = (await screenOf(term, 60, 20)).join('\n')
    // A per-request environment snapshot is harness-internal. It is sent to the model when it
    // changes and is never a line in the transcript -- neither the label nor the payload.
    expect(screen).not.toContain('context:')
    expect(screen).not.toContain('{"model"')
    expect(screen).not.toContain('/repo')
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('the loader spins while a turn is in flight and shows the elapsed time once it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-loader-'))
  const { host } = await createTestHost({ dataDir: dir, provider: slowProvider(800) })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    // Before the first turn, the loader row must not exist at all -- spec RP1.2's "zero rows
    // before the first turn", not merely "empty label".
    expect((await screenOf(term, 80, 24)).join('\n')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    term.feed('slow question')
    term.feed('\r')
    await vi.waitFor(
      async () => {
        const screen = (await screenOf(term, 80, 24)).join('\n')
        // Any frame past the very first proves the shared ticker actually advanced it, not just
        // that the loader mounted once when the turn started.
        expect(screen).toMatch(/[⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
      },
      { timeout: 5_000 },
    )
    await vi.waitFor(() => expect(app?.busy).toBe(false), { timeout: 5_000 })
    await vi.waitFor(async () => {
      expect((await screenOf(term, 80, 24)).join('\n')).toMatch(/✓ turn 1 · 0\.[0-9]s/)
    })
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('renders a 1000-tool-card timeline well within one ticker interval (RP1.1 regression guard)', () => {
  const ansi = createAnsi('none')
  const nodes: UINode[] = Array.from({ length: 1_000 }, (_, i) => ({
    kind: 'tool' as const,
    id: `t${i}`,
    seq: i + 1,
    toolUseId: `call-${i}`,
    name: 'read',
    status: i % 7 === 0 ? 'running' : 'completed',
    summary: `packages/example/file-${i}.ts:1-20`,
  }))
  const timeline = new Timeline({
    rows: () => 24,
    nodeView: (node) => new ToolCard(node as Extract<UINode, { kind: 'tool' }>, { collapsed: true, ansi }),
  })
  timeline.apply({ sessionId: 's', generation: 1, upto: 1_000, opState: null, nodes, turns: [] })
  timeline.render(80)
  const start = performance.now()
  timeline.render(80)
  const elapsedMs = performance.now() - start
  // Measured at plan-writing time: median 2.2ms, max 3.0ms over 20 samples at this node count --
  // this asserts a ceiling with a wide margin so it only fires on a real regression, not noise.
  // If it ever does fire, RP1's ticker must stop calling requestRender() wholesale and switch to
  // redrawing only the loader's own row (spec RP1.1).
  expect(elapsedMs).toBeLessThan(20)
})

// Fix round (post-review): `applyOpState`'s null/non-null edge detection alone cannot see a turn
// number changing while `opState` stays non-null the whole time -- exactly what a debounced
// projection tick can coalesce (projection.ts's REPROJECT_DEBOUNCE_MS skips an intervening
// `opState: null`). Reaches `applyOpState` directly (a private method) rather than driving a real
// timed turn through a real host, which is the more deterministic way to force the exact coalesced
// sequence a real debounce could produce non-deterministically.
it('re-baselines the wall clock on a coalesced turn boundary instead of fabricating an elapsed time', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:coalesce' }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  const internals = app as unknown as {
    apply(value: UITimeline, options?: { opening?: boolean }): void
    loader: { render(width: number): string[] }
  }
  const clock = vi.spyOn(Date, 'now')
  try {
    const base = { sessionId: session.id, generation: 1, nodes: [] as UINode[], turns: [] }
    clock.mockReturnValue(0)
    internals.apply({ ...base, upto: 1, opState: { turn: 1, step: 1, phase: 'turn 1 running' } })
    // The coalesced boundary: turn jumps 1 -> 2 while opState stays non-null the whole time, so
    // the null/non-null edge detection alone never fires here.
    clock.mockReturnValue(5_000)
    internals.apply({ ...base, upto: 2, opState: { turn: 2, step: 1, phase: 'turn 2 running' } })
    clock.mockReturnValue(8_000)
    internals.apply({ ...base, upto: 3, opState: null })
    const [line] = internals.loader.render(80)
    // Correct: turn 2's own 3s (8_000 - 5_000 re-baselined at the coalesced boundary), never
    // turn 1's 5s and never the fabricated 8s a stale turnStartedAt would have produced.
    expect(line).toContain('✓ turn 2 · 3.0s')
    expect(line).not.toContain('turn 1')
    expect(line).not.toContain('8.0s')
  } finally {
    clock.mockRestore()
    await app.stop()
    await client.close()
    await endpoint.close()
  }
})

it('resets the turn clock and stops the ticker across a mid-turn session switch', async () => {
  const { endpoint, sessions } = fakeSessionEndpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    const internals = app as unknown as {
      applyOpState(opState: UITimeline['opState']): void
      ticker?: unknown
      turnActive: boolean
      turnStartedAt?: number
      currentTurn: number
      loader: { render(width: number): string[] }
    }
    // A turn genuinely in flight on the OLD session: ticker running, loader spinning on it.
    internals.applyOpState({ turn: 7, step: 1, phase: 'mid-flight' })
    expect(internals.ticker).not.toBeUndefined()
    expect(internals.loader.render(60)[0]).toContain('mid-flight')

    term.feed('/new')
    term.feed('\r')
    await vi.waitFor(() => expect(sessions()).toBe(2))
    // `projection.stop()` on the old session never synthesizes a closing `opState: null` tick for
    // the turn that was in flight, so this waits for the new session's own first (idle) apply()
    // tick to have actually landed -- the same point at which a stale ticker/loader would leak the
    // old session's turn number and elapsed time onto the new session's screen.
    await vi.waitFor(async () => expect((await screenOf(term, 60, 20)).join('\n')).toContain('li:dm:s2'))

    expect(internals.ticker).toBeUndefined()
    expect(internals.turnActive).toBe(false)
    expect(internals.turnStartedAt).toBeUndefined()
    expect(internals.currentTurn).toBe(0)
    // Zero rows, matching a freshly-constructed TuiApp -- not a stale "✓ turn 7 · Xs" bleeding
    // across the switch.
    expect(internals.loader.render(60)).toEqual([])
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

// A real macOS run: TUI mid-turn, `agnes daemon stop` then `start`. The SDK announces 'closed' after
// the daemon's shutting_down notice; the TUI ignored it, so the spinner ran forever and a prompt typed
// afterwards re-dialed the new daemon and ran there with nothing subscribed to render it.
async function daemonRestartHarness(
  options: { hangPrompt?: boolean; nodes?: UINode[]; journal?: JournalStore } = {},
) {
  const SID = 'agnes:local:default:cli:dm:shutdown'
  const init = () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
  })
  const timeline = (opState: unknown, nodes: UINode[] = []) => ({
    sessionId: SID,
    generation: 1,
    upto: 1,
    opState,
    turns: [],
    nodes,
  })
  let created = 0
  const oldDaemon = new FakeEndpoint()
    .on('initialize', init)
    .on('session/new', () => ({ sessionId: created++ === 0 ? SID : `${SID}-${created}` }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 1, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline({ turn: 1, step: 1, phase: 'tools' }, options.nodes))
    .on('session/prompt', () => (options.hangPrompt ? new Promise(() => {}) : { stopReason: 'end_turn' }))
  const newDaemon = new FakeEndpoint()
    .on('initialize', init)
    .on('session/load', () => ({}))
    .on('_agnes/v1/session.attach', () => ({ generation: 2, lastSeq: 1, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => timeline(null))
    .on('session/prompt', () => ({ stopReason: 'end_turn' }))
    .on('_agnes/v1/approval.decide', () => ({}))
  // The unix transport re-dials the same socket path, which after a restart is the new daemon.
  let dials = 0
  const sameAddress: TransportFactory = (h) => inprocTransport(dials++ === 0 ? oldDaemon : newDaemon)(h)
  const client = createClient({
    transport: { kind: 'inproc', endpoint: oldDaemon },
    transportFactories: { inproc: () => sameAddress },
    ...(options.journal ? { journal: options.journal } : {}),
  })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const session = await client.session.new({ cwd: '/tmp' })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  const quit = vi.fn()
  app.onQuit = quit
  await app.start()
  return {
    term,
    quit,
    newDaemon,
    dials: () => dials,
    screen: async () => (await screenOf(term, 80, 24)).join('\n'),
    stopDaemon: async () => {
      const closed = new Promise((resolve) => client.on('closed', resolve))
      oldDaemon.pushNotice({ kind: 'shutting_down', detail: {}, at: new Date(0).toISOString() })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await oldDaemon.close()
      await closed
    },
    dispose: async () => {
      await app.stop()
      await client.close()
      await newDaemon.close()
    },
  }
}

const spinnerFrames = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

it('stops the turn spinner on a terminal close and refuses input it could never render', async () => {
  const h = await daemonRestartHarness()
  try {
    await expect.poll(h.screen).toMatch(spinnerFrames)
    await h.stopDaemon()
    await vi.waitFor(async () => {
      const screen = await h.screen()
      expect(screen).not.toMatch(spinnerFrames)
      expect(screen).toContain('--resume')
    })
    h.term.feed('hello')
    h.term.feed('\r')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.dials()).toBe(1)
    expect(h.newDaemon.calls.map((c) => c.method)).not.toContain('session/prompt')
  } finally {
    await h.dispose()
  }
})

it('after a terminal close, a padded /quit quits locally instead of being sent as a prompt', async () => {
  const h = await daemonRestartHarness()
  try {
    await h.stopDaemon()
    h.term.feed(' /quit ')
    h.term.feed('\r')
    await vi.waitFor(() => expect(h.quit).toHaveBeenCalled())
    expect(h.dials()).toBe(1)
    expect(h.newDaemon.calls).toEqual([])
  } finally {
    await h.dispose()
  }
})

it('a terminal close cancels the queued-prompt wake so nothing re-dials in the background', async () => {
  const h = await daemonRestartHarness({ hangPrompt: true })
  try {
    h.term.feed('first')
    h.term.feed('\r')
    await vi.waitFor(async () => expect(await h.screen()).toMatch(spinnerFrames))
    // Busy with a prompt in flight: this one is queued and arms the 100ms wake poll.
    h.term.feed('second')
    h.term.feed('\r')
    await vi.waitFor(async () => expect(await h.screen()).toContain('Queued: second'))
    await h.stopDaemon()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.dials()).toBe(1)
    expect(h.newDaemon.calls).toEqual([])
  } finally {
    await h.dispose()
  }
})

it('a terminal close stops a parked approval card from deciding its ticket on the restarted daemon', async () => {
  // Parked tickets are durable: the restarted daemon would accept this decision and resume the tool.
  const h = await daemonRestartHarness({
    nodes: [
      {
        kind: 'approval',
        id: 'ap1',
        seq: 1,
        state: 'pending',
        summary: 'shell rm -rf tmp',
        risk: 'destructive',
        options: ['allow_once', 'allow_always', 'reject_once'],
        ticket: 'tk-parked',
      },
    ],
  })
  try {
    await vi.waitFor(async () => expect(await h.screen()).toContain('ticket tk-parke'))
    await h.stopDaemon()
    h.term.feed('1')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.dials()).toBe(1)
    expect(h.newDaemon.calls).toEqual([])
  } finally {
    await h.dispose()
  }
})

it('a terminal close that lands mid session switch does not start the new session projection', async () => {
  // Hold the switch inside projection.stop(): ending the old iterator persists its cursor.
  const base = memoryJournal()
  let hold: Promise<void> | undefined
  let reached!: () => void
  const atCursor = new Promise<void>((resolve) => {
    reached = resolve
  })
  const journal: JournalStore = {
    ...base,
    async setCursor(sessionId, cursor) {
      if (hold) {
        reached()
        await hold
      }
      return base.setCursor(sessionId, cursor)
    },
  }
  const h = await daemonRestartHarness({ journal })
  let release!: () => void
  try {
    await vi.waitFor(async () => expect(await h.screen()).toMatch(spinnerFrames))
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    h.term.feed('/new')
    h.term.feed('\r')
    await atCursor
    await h.stopDaemon()
    release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(h.dials()).toBe(1)
    expect(h.newDaemon.calls).toEqual([])
  } finally {
    release?.()
    await h.dispose()
  }
})

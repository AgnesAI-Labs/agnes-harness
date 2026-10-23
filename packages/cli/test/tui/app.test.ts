import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  createPrivateDirectorySync,
  hasPrivateDaclSync,
  windowsProtectPrivateFileSync,
} from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { type Colour, createAnsi } from '../../src/tui/ansi.js'
import { TuiApp } from '../../src/tui/app.js'
import { SLASH_COMMANDS } from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { type Tone, TuiTheme } from '../../src/tui/theme.js'
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
  // The bell is the background alert on any terminal but the verified ones; pin it.
  vi.stubEnv('AGH_NOTIFY', 'bell')
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
    const bells = () => term.writes.filter((w) => w === '\x07').length
    // In the foreground the first turn ended without a bell; in the background the next one rings once.
    expect(bells()).toBe(0)
    term.feed('\x1b[O')
    term.feed('second question')
    term.feed('\r')
    await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('next answer'))
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    await vi.waitFor(() => expect(bells()).toBe(1))
    expect(term.writes.join('')).toContain('\x1b[?1004h')
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
    expect(term.writes.filter((w) => w === '\x1b[22;0t')).toHaveLength(1)
    expect(term.writes.filter((w) => w === '\x1b[23;0t')).toHaveLength(1)
    expect(session.listeners.size).toBe(0)
    const writes = term.writes.length
    term.feed('after stop')
    expect(term.writes).toHaveLength(writes)
  } finally {
    vi.unstubAllEnvs()
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

it('keeps an unknown error generic without exposing the raw failure message', async () => {
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
      expect((await screenOf(term, 80, 24)).join('\n')).toContain('Request failed. Try again.'),
    )
    expect((await screenOf(term, 80, 24)).join('\n')).not.toContain('secret backend detail')
  } finally {
    await app.stop()
    await client.close()
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

it('Esc cancels actual core inference and keeps the half-written draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-esc-'))
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
    term.feed('half a thought')
    term.feed('\x1b')
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    expect((await session.projectUI()).opState).toBeNull()
    const shown = async () => (await screenOf(term, 80, 24)).join('\n')
    await vi.waitFor(async () => expect(await shown()).toContain('half a thought'))
    // With nothing running, the same key clears the draft as before.
    term.feed('\x1b')
    await vi.waitFor(async () => expect(await shown()).not.toContain('half a thought'))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

type Submitted = { kind: string; commandId: string; payload: Record<string, unknown> }

/** fakeSessionEndpoint that records every `_agnes/v1/submit` and answers it like a daemon that accepted it. */
function submitEndpoint(answer: (params: Submitted) => unknown = () => ({ seq: 1, replayed: false })) {
  const base = fakeSessionEndpoint()
  const submits: Submitted[] = []
  base.endpoint
    .on('_agnes/v1/submit', (params) => {
      submits.push(params as Submitted)
      return answer(params as Submitted)
    })
    .on('_agnes/v1/submit.ack', () => ({}))
  return { ...base, submits }
}

it.each([
  ['sends the cancel', undefined, undefined],
  [
    'says only the owner can cancel when the daemon refuses it',
    rpcError('CAPABILITY_DENIED', {}),
    'Only the session owner can cancel this turn',
  ],
  [
    'names the code of a rejected cancel',
    rpcError('SEMANTIC_REJECTED', { code: 'LOOP_CONTROL_UNSUPPORTED' }),
    'Cancel refused (LOOP_CONTROL_UNSUPPORTED)',
  ],
])('treats a turn another client started as busy, and Ctrl-C %s', async (_name, refusal, shown) => {
  const { endpoint, submits } = submitEndpoint(() => {
    if (refusal) throw refusal
    return { seq: 1, replayed: false }
  })
  endpoint.on('_agnes/v1/session.projectUI', () => ({
    ...EMPTY_TIMELINE,
    opState: { turn: 1, step: 1, phase: 'tools' },
  }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await vi.waitFor(() => expect(app?.busy).toBe(true))
    term.feed('\x03')
    await vi.waitFor(() =>
      expect(submits.map((s) => [s.kind, s.payload.action])).toEqual([['control', 'cancel']]),
    )
    if (shown)
      await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain(shown))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
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
    const copied: string[] = []
    app = new TuiApp({ session, term, header: 'Agnes', copy: (text) => copied.push(text) })
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
    const bottom = (await emulate(term, 40, 16)).lines
    // The wheel scrolls the same window; without mouse reporting it would arrive as arrow keys and
    // recall "long question" into the prompt instead.
    expect(term.writes.join('')).toContain('\x1b[?1002h\x1b[?1006h')
    term.feed('\x1b[<64;1;1M'.repeat(10))
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 1'))
    term.feed('\x1b[<65;1;1M'.repeat(10))
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 8'))
    expect((await emulate(term, 40, 16)).lines).toEqual(bottom)
    // End returns to the bottom; with a draft, End stays with the cursor and only Ctrl-End jumps.
    term.feed('\x1b[5~')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 1'))
    term.feed('\x1b[F')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 8'))
    expect((await emulate(term, 40, 16)).lines).toEqual(bottom)
    term.feed('draft')
    term.feed('\x1b[5~')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 1'))
    term.feed('\x1b[F')
    expect((await emulate(term, 40, 16)).lines).toContain('line 1')
    term.feed('\x1b[1;5F')
    await vi.waitFor(async () => expect((await emulate(term, 40, 16)).lines).toContain('line 8'))
    term.feed('\x15')
    // Dragging over the reply copies what the screen shows and says so without moving a row.
    const row = bottom.indexOf('line 8') + 1
    term.feed(`\x1b[<0;1;${row}M\x1b[<32;7;${row}M\x1b[<0;7;${row}m`)
    expect(copied).toEqual(['line 8'])
    await vi.waitFor(async () =>
      expect((await emulate(term, 40, 16)).lines.join('\n')).toContain('✓ Copied to clipboard'),
    )
    expect((await emulate(term, 40, 16)).lines.indexOf('line 8')).toBe(row - 1)
    expect((await emulate(term, 40, 16)).scrollback).toEqual(history)
    await app.stop()
    expect(term.writes.join('')).toContain('\x1b[?1006l\x1b[?1002l\x1b[?1049l')
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
      expect(lines.some((line) => line.trimEnd() === ' ▍ **literal question**')).toBe(true)
      expect(lines).toContain('Answer')
      expect(lines).toContain('bold')
      expect(lines).toContain('• item')
      expect(lines).toContain(`${'  let x = 1'.padEnd(36)} js`)
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
    opState: null,
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

// Ctrl+O on a tool card asks the daemon for the whole record; the previews stay on screen until the
// answer lands, and when it cannot be had the card keeps them and names the reason on one line.
it.each([
  ['replaces the previews with the full record', false],
  ['keeps the previews and says why the record could not be read', true],
])('Ctrl+O %s', async (_name, refuse) => {
  const SID = 'agnes:local:default:cli:dm:detail'
  const record = {
    call: { toolUseId: 'c1', name: 'query', args: { sql: 'select 1', limit: 3 }, ordinal: 0 },
    result: {
      toolUseId: 'c1',
      content: [{ type: 'text', text: 'full line one\nfull line two' }],
      isError: false,
      enforcement: { level: 'none', scope: [] },
      authz: { decisionId: 'd1' },
    },
  }
  const body = JSON.stringify(record)
  const reads: unknown[] = []
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
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        {
          kind: 'tool',
          id: 't1',
          seq: 1,
          resultSeq: 2,
          toolUseId: 'c1',
          name: 'query',
          status: 'completed',
          summary: '2 rows',
          argsPreview: '{"sql":"sel…',
          resultPreview: 'preview only',
        },
      ],
    }))
    .on('_agnes/v1/session.readToolDetail', (params) => {
      reads.push(params)
      if (refuse) throw rpcError('INTERNAL_ERROR', { reason: 'boom' })
      return {
        sessionId: SID,
        callSeq: 1,
        resultSeq: 2,
        offset: 0,
        totalBytes: Buffer.byteLength(body),
        data: Buffer.from(body).toString('base64'),
        nextOffset: null,
      }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 20 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 80, 20)).join('\n')).toContain('◆ query  2 rows'),
    )
    term.feed('\x0f')
    // Expanding is immediate and shows the previews; the fetch is asked for exactly this call/result pair.
    await vi.waitFor(() => expect(reads).toEqual([{ sessionId: SID, callSeq: 1, resultSeq: 2, offset: 0 }]))
    await vi.waitFor(async () => {
      const screen = (await screenOf(term, 80, 20)).join('\n')
      if (refuse) {
        expect(screen).toContain('preview only')
        expect(screen).toContain('Full record unavailable (Request failed (INTERNAL_ERROR)')
      } else {
        expect(screen).toContain('full line two')
        expect(screen).toContain('"sql": "select 1"')
        expect(screen).not.toContain('preview only')
      }
    })
    // Closing and opening again retries only a failed fetch.
    term.feed('\x0f')
    term.feed('\x0f')
    await vi.waitFor(() => expect(reads).toHaveLength(refuse ? 2 : 1))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

// A click on a card's head row opens that card, whichever one it is; Ctrl-O keeps toggling the latest.
it('toggles the clicked tool card by its head row', async () => {
  const SID = 'agnes:local:default:cli:dm:click'
  const tool = (n: number) => ({
    kind: 'tool',
    id: `t${n}`,
    seq: n,
    toolUseId: `c${n}`,
    name: 'query',
    status: 'completed',
    summary: `rows ${n}`,
    argsPreview: `{"n":${n}}`,
  })
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
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [tool(1), tool(2)],
    }))
    .on('_agnes/v1/session.readToolDetail', () => {
      throw rpcError('INTERNAL_ERROR', { reason: 'unused' })
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 20 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await vi.waitFor(async () => expect((await screenOf(term, 80, 20)).join('\n')).toContain('rows 2'))
    const click = async (label: string) => {
      const row = (await screenOf(term, 80, 20)).findIndex((line) => line.includes(label)) + 1
      expect(row).toBeGreaterThan(0)
      term.feed(`\x1b[<0;5;${row}M\x1b[<0;5;${row}m`)
    }
    await click('rows 1') // the older card, not the latest
    await vi.waitFor(async () => expect((await screenOf(term, 80, 20)).join('\n')).toContain('{"n":1}'))
    expect((await screenOf(term, 80, 20)).join('\n')).not.toContain('{"n":2}')
    await click('query') // the first card's head again closes it
    await vi.waitFor(async () => expect((await screenOf(term, 80, 20)).join('\n')).not.toContain('{"n":1}'))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

// The plan, subagent and job tools get cards of their own, built from the projected timeline alone:
// a subagent's state and time come from the trace spans, which change while its node does not.
it('draws plan, subagent and job cards from the projected timeline', async () => {
  const SID = 'agnes:local:default:cli:dm:cards'
  const span = (over: Record<string, unknown>) => ({
    id: 'sp',
    kind: 'other',
    name: 'n',
    status: 'completed',
    startSeq: 1,
    startedAt: '2026-10-22T00:00:00Z',
    children: [],
    nodeIds: [],
    ...over,
  })
  const tool = (id: string, seq: number, over: Record<string, unknown>) => ({
    kind: 'tool',
    id,
    seq,
    toolUseId: id,
    status: 'completed',
    summary: '',
    ...over,
  })
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
      upto: 3,
      generation: 1,
      opState: null,
      turns: [
        {
          id: 'turn-1',
          turn: 1,
          startSeq: 1,
          startedAt: '2026-10-22T00:00:00Z',
          status: 'completed',
          nodeIds: [],
          usage: {
            totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            reasoningComplete: true,
            billingComplete: true,
            calls: [],
          },
          inherited: false,
          forkable: false,
          trace: span({
            kind: 'turn',
            children: [span({ kind: 'subagent', childSessionKey: 'kid', durationMs: 4_200 })],
          }),
        },
      ],
      nodes: [
        tool('p', 1, {
          name: 'update_plan',
          argsPreview: JSON.stringify({
            plan: [
              { step: 'read the code', status: 'completed' },
              { step: 'write the card', status: 'in_progress' },
            ],
          }),
        }),
        tool('a', 2, {
          name: 'subagent_spawn',
          summary: 'spawned',
          delegatedTask: { childKey: 'kid', task: 'check the build', status: 'running' },
        }),
        tool('j', 3, { name: 'job_list', summary: '2 jobs' }),
      ],
    }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    await vi.waitFor(async () => {
      const screen = (await screenOf(term, 80, 24)).join('\n')
      expect(screen).toContain('Plan  1/2 done')
      expect(screen).toContain('[x] read the code')
      expect(screen).toContain('[>] write the card')
      expect(screen).toContain('Subagent  check the build')
      // Its node still says running; the child's finished turn span has the final state and time.
      expect(screen).toMatch(/Subagent {2}check the build\s+done · 4\.2s/)
      expect(screen).toMatch(/Job job_list {2}2 jobs\s+done/)
    })
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

/** An app whose first prompt stays in flight until `release()`, so everything typed after it arrives busy. */
async function busyHarness(
  opts: { answer?: (params: Submitted) => unknown; steer?: boolean; promptError?: unknown } = {},
) {
  const { endpoint, submits } = submitEndpoint(opts.answer)
  const prompts: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  endpoint.on('_agnes/v1/session.controls', () => ({
    controls: { steer: opts.steer ?? true },
    paused: false,
    pending: [],
  }))
  endpoint.on('session/prompt', async (params) => {
    prompts.push((params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? '')
    if (opts.promptError) throw opts.promptError
    if (prompts.length === 1) await gate
    return { stopReason: 'end_turn' }
  })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 100, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  await app.start()
  return {
    app,
    term,
    endpoint,
    submits,
    prompts,
    release,
    shown: async () => (await screenOf(term, 100, 24)).join('\n'),
    type: (text: string, key = '\r') => {
      term.feed(text)
      term.feed(key)
    },
    async dispose() {
      release()
      await app.stop()
      await client.close()
      await endpoint.close()
    },
  }
}

it('Enter while a turn runs queues the input in the daemon under its own command id, hinting once', async () => {
  const h = await busyHarness()
  try {
    h.type('a')
    await vi.waitFor(() => expect(h.prompts).toEqual(['a']))
    h.type('b')
    await vi.waitFor(() => expect(h.submits).toHaveLength(1))
    await vi.waitFor(async () => expect(await h.shown()).toContain('Alt+Enter steers the running turn'))
    h.type('c')
    await vi.waitFor(() => expect(h.submits).toHaveLength(2))
    await vi.waitFor(async () => expect(await h.shown()).toContain('Queued: c'))
    expect(await h.shown()).not.toContain('Alt+Enter steers')
    expect(h.submits.map((s) => [s.kind, s.payload.content])).toEqual([
      ['followUp', [{ type: 'text', text: 'b' }]],
      ['followUp', [{ type: 'text', text: 'c' }]],
    ])
    expect(new Set(h.submits.map((s) => s.commandId)).size).toBe(2)
    // Nothing is held here: the daemon owns the queue, and no second prompt was sent.
    h.release()
    await vi.waitFor(() => expect(h.app.busy).toBe(false))
    expect(h.prompts).toEqual(['a'])
  } finally {
    await h.dispose()
  }
})

it('Alt+Enter while a turn runs steers it, and queues instead when the turn takes no guidance', async () => {
  const image = { type: 'resource_link' as const, uri: 'artifact://clipboard-image', name: 'clipboard.png' }
  const steering = await busyHarness()
  try {
    steering.type('a')
    await vi.waitFor(() => expect(steering.prompts).toEqual(['a']))
    steering.app.busyInput.attach('[Image #1]', image, steering.app.session.id)
    steering.type('look at b [Image #1]', '\x1b\r')
    await vi.waitFor(() => expect(steering.submits.map((s) => s.kind)).toEqual(['steer']))
    expect(steering.submits[0]?.commandId).toBeTruthy()
    expect(steering.submits[0]?.payload.content).toEqual([
      { type: 'text', text: 'look at b [Image #1]' },
      image,
    ])
    expect(steering.app.busyInput.takeKept('[Image #1]')).toEqual([])
    await vi.waitFor(async () =>
      expect(await steering.shown()).toContain('Sent to the running turn: look at b'),
    )
  } finally {
    await steering.dispose()
  }
  const refusing = await busyHarness({ steer: false })
  try {
    refusing.type('a')
    await vi.waitFor(() => expect(refusing.prompts).toEqual(['a']))
    refusing.app.busyInput.attach('[Image #1]', image, refusing.app.session.id)
    refusing.type('b [Image #1]', '\x1b\r')
    await vi.waitFor(() => expect(refusing.submits.map((s) => s.kind)).toEqual(['followUp']))
    expect(refusing.submits[0]?.payload.content).toEqual([{ type: 'text', text: 'b [Image #1]' }, image])
    await vi.waitFor(async () => expect(await refusing.shown()).toContain('queued instead'))
  } finally {
    await refusing.dispose()
  }
})

it('keeps clipboard temporary files private under the CLI private directory and cleans failed reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-clipboard-'))
  const directory = join(root, '中文 clipboard')
  createPrivateDirectorySync(directory)
  const h = await busyHarness()
  const permissions: boolean[] = []
  h.app.o.externalEditor = { env: {}, tmpDir: directory }
  h.app.o.clipboard = {
    readImage: async (file) => {
      // Node inherits this private parent's ACL. The native validator refuses foreign/broad
      // grants before freezing inheritance; it does not turn a shared file into a private one.
      if (process.platform === 'win32') windowsProtectPrivateFileSync(file)
      permissions.push(hasPrivateDaclSync(directory), hasPrivateDaclSync(file))
      return { ok: false, reason: 'empty' }
    },
  }
  try {
    await h.app.command('/paste')
    expect(permissions).toEqual([true, true])
    expect(readdirSync(directory)).toEqual([])
    expect(h.submits).toEqual([])
  } finally {
    await h.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

it('retries a failed queue submit once under the same command id, then returns the draft to the editor', async () => {
  let failures = 1
  const retried = await busyHarness({
    answer: () => {
      if (failures-- > 0) throw rpcError('INTERNAL_ERROR', {})
      return { seq: 1, replayed: false }
    },
  })
  try {
    retried.type('a')
    await vi.waitFor(() => expect(retried.prompts).toEqual(['a']))
    retried.type('b')
    await vi.waitFor(() => expect(retried.submits).toHaveLength(2))
    expect(retried.submits[1]?.commandId).toBe(retried.submits[0]?.commandId)
    await vi.waitFor(async () => expect(await retried.shown()).toContain('Queued: b'))
  } finally {
    await retried.dispose()
  }
  const failing = await busyHarness({
    answer: () => {
      throw rpcError('SEMANTIC_REJECTED', { code: 'LOOP_CONTROL_UNSUPPORTED' })
    },
  })
  try {
    failing.type('a')
    await vi.waitFor(() => expect(failing.prompts).toEqual(['a']))
    const image = { type: 'resource_link' as const, uri: 'artifact://clipboard-image', name: 'clipboard.png' }
    failing.app.busyInput.attach('[Image #1]', image, failing.app.session.id)
    failing.type('keep me [Image #1]')
    // A definitive refusal clears the SDK journal; both attempts still use the same command id.
    await vi.waitFor(() => expect(failing.submits).toHaveLength(2))
    expect(new Set(failing.submits.map((s) => s.commandId)).size).toBe(1)
    await vi.waitFor(async () => {
      const screen = await failing.shown()
      expect(screen).toContain('Not sent: the draft is back in the editor')
      expect(screen).toMatch(/❯ keep me \[Image #1\]\s*$/m)
    })
    expect(failing.app.busyInput.takeKept(failing.app.editor.expanded())).toEqual([image])
    failing.release()
    await vi.waitFor(() => expect(failing.app.busy).toBe(false))
    // No local replay: the only prompt this client ever sent is the first one.
    expect(failing.prompts).toEqual(['a'])
  } finally {
    await failing.dispose()
  }
  const unknown = await busyHarness({
    answer: () => {
      throw rpcError('INTERNAL_ERROR', {})
    },
  })
  try {
    unknown.type('a')
    await vi.waitFor(() => expect(unknown.prompts).toEqual(['a']))
    const image = { type: 'resource_link' as const, uri: 'artifact://clipboard-image', name: 'clipboard.png' }
    unknown.app.busyInput.attach('[Image #1]', image, unknown.app.session.id)
    unknown.type('answer lost [Image #1]')
    await vi.waitFor(async () => expect(await unknown.shown()).toContain('Not sure the daemon took it'))
    expect(unknown.submits).toHaveLength(3)
    expect(new Set(unknown.submits.map((s) => s.commandId)).size).toBe(1)
    expect(await unknown.app.session.pendingCommands()).toMatchObject([{ state: 'needs-confirmation' }])
    expect(unknown.app.editor.text).toBe('')
    expect(unknown.app.busyInput.takeKept('[Image #1]')).toEqual([])
    unknown.release()
    await vi.waitFor(() => expect(unknown.app.busy).toBe(false))
    expect(unknown.submits).toHaveLength(3)
    expect(unknown.prompts).toEqual(['a'])
  } finally {
    await unknown.dispose()
  }
  // The daemon took the command but the answers were lost twice: the check under the same id lands it.
  let lost = 2
  const landed = await busyHarness({
    answer: () => {
      if (lost-- > 0) throw rpcError('INTERNAL_ERROR', {})
      return { seq: 1, replayed: true }
    },
  })
  try {
    landed.type('a')
    await vi.waitFor(() => expect(landed.prompts).toEqual(['a']))
    landed.type('kept by daemon')
    await vi.waitFor(async () => expect(await landed.shown()).toContain('it is queued, see /queue'))
    expect(landed.submits).toHaveLength(3)
    expect(new Set(landed.submits.map((s) => s.commandId)).size).toBe(1)
    expect(await landed.shown()).not.toMatch(/❯ kept by daemon/)
  } finally {
    await landed.dispose()
  }
})

it('Alt+Up takes the newest queued message back into an empty editor, and its attachment goes out with the next one', async () => {
  const link = { type: 'resource_link', uri: 'file:///w/a.txt', name: 'a.txt' }
  const h = await busyHarness()
  h.endpoint.on('_agnes/v1/session.controls', () => ({
    controls: {},
    paused: false,
    pending: [
      { itemId: 'one', target: 'next-turn', kind: 'follow_up', content: [{ type: 'text', text: 'older' }] },
      {
        itemId: 'two',
        target: 'next-turn',
        kind: 'follow_up',
        content: [{ type: 'text', text: 'newer\u001b[2J\u0007\nline2' }, link],
      },
    ],
  }))
  try {
    h.term.feed('half typed')
    h.term.feed('\x1b[1;3A')
    await new Promise((resolve) => setTimeout(resolve, 100))
    // A draft is never overwritten.
    expect(h.submits).toEqual([])
    h.term.feed('\x15') // Ctrl-U clears the draft
    h.term.feed('\x1b[1;3A')
    await vi.waitFor(() =>
      expect(h.submits.map((s) => [s.kind, s.payload.itemId])).toEqual([['removeQueued', 'two']]),
    )
    expect(h.submits[0]?.commandId).toBeTruthy()
    await vi.waitFor(async () => {
      const screen = await h.shown()
      expect(screen).toMatch(/❯ newer\[2J\s*$/m)
      expect(screen).toContain('line2')
    })
    h.term.feed('\r')
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    const prompt = h.endpoint.calls.find((c) => c.method === 'session/prompt')?.params as {
      prompt: Array<{ type: string }>
    }
    expect(prompt.prompt.map((b) => b.type)).toEqual(['text', 'resource_link'])
  } finally {
    await h.dispose()
  }
})

it('Esc Esc on an empty idle editor opens the rewind picker, and does not when a draft is there', async () => {
  const { endpoint } = fakeSessionEndpoint()
  endpoint.on('_agnes/v1/session.projectUI', () => ({
    ...EMPTY_TIMELINE,
    upto: 12,
    turns: [
      {
        id: 't1',
        turn: 1,
        startSeq: 10,
        endSeq: 12,
        startedAt: '2026-10-03T00:00:00Z',
        status: 'completed',
        nodeIds: ['u1'],
        usage: {
          totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          reasoningComplete: true,
          billingComplete: true,
          calls: [],
        },
        inherited: false,
        forkable: true,
      },
    ],
    nodes: [{ kind: 'user', id: 'u1', seq: 10, content: [{ type: 'text', text: 'earlier question' }] }],
  }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    const shown = async () => (await screenOf(term, 80, 24)).join('\n')
    // The first Esc clears the draft; it takes a later pair on the empty editor to ask for the picker.
    term.feed('half typed')
    term.feed('\x1b')
    term.feed('\x1b')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await shown()).not.toContain('Rewind To Turn')
    await new Promise((resolve) => setTimeout(resolve, 500))
    term.feed('\x1b')
    term.feed('\x1b')
    await vi.waitFor(async () => {
      const screen = await shown()
      expect(screen).toContain('Rewind To Turn')
      expect(screen).toContain('#1 earlier question')
    })
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('queues a prompt the daemon refused as busy exactly once, and shows any other refusal as it comes', async () => {
  const lagging = await busyHarness({ promptError: rpcError('SESSION_BUSY', {}) })
  try {
    lagging.type('x')
    await vi.waitFor(() =>
      expect(lagging.submits.map((s) => [s.kind, s.payload.content])).toEqual([
        ['followUp', [{ type: 'text', text: 'x' }]],
      ]),
    )
    await vi.waitFor(() => expect(lagging.app.busy).toBe(false))
    expect(lagging.prompts).toEqual(['x'])
  } finally {
    await lagging.dispose()
  }
  const overloaded = await busyHarness({ promptError: rpcError('OVERLOADED', {}) })
  try {
    overloaded.type('x')
    await vi.waitFor(async () => expect(await overloaded.shown()).toContain('Request failed'))
    expect(overloaded.submits).toEqual([])
    expect(overloaded.prompts).toEqual(['x'])
  } finally {
    await overloaded.dispose()
  }
})

it('paints the startup welcome and editor surface once across /new', async () => {
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
      // 60 columns by 20 rows is too short for art: the welcome is two plain lines.
      expect(text).toContain('agnes ·ᴗ·  deepseek-v4-pro')
      expect(text).toContain('local-dev')
      expect(text).not.toContain('Ctrl+C×2 退出')
      expect(text).toContain('What do you want to do? Start with a sentence.')
    })
    term.feed('/new')
    term.feed('\r')
    await vi.waitFor(() => expect(sessions()).toBe(2))
    // The banner belongs to the app, not the session: the switch must not repaint it.
    await vi.waitFor(() => expect(app?.session.id).toContain('s2'))
    const text = (await screenOf(term, 60, 20)).join('\n')
    expect(text.split('agnes ·ᴗ·  resolving model').length - 1).toBe(1)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
})

it('fills the welcome after the first frame, omits what fails, and shows the full welcome on every launch', async () => {
  const launch = async (resources: boolean) => {
    const { endpoint } = fakeSessionEndpoint()
    endpoint
      .on('_agnes/v1/session.list', () => ({
        items: [
          {
            sessionId: 'x1',
            createdAt: new Date(Date.now() - 7_200_000).toISOString(),
            lastSeq: 3,
            generation: 1,
            preset: null,
            title: 'Earlier work',
          },
        ],
      }))
      .on('_agnes/v1/session.tools', () => {
        if (!resources) throw new Error('unavailable')
        const on = (n: number) =>
          Array.from({ length: n }, (_, i) => ({ id: `i${i}`, enabled: true, reasons: [] }))
        return {
          sessionId: 'x',
          tools: [],
          resources: [],
          capabilities: {
            preset: 'standard',
            bundles: [],
            codePin: { legacy: false, packages: [] },
            loop: { value: { id: 'l', version: '1' }, source: { layer: 'default', name: 'x' } },
            modelRoutes: { value: null, source: { layer: 'default', name: 'x' } },
            permissions: {
              preset: 'standard',
              policy: 'p',
              toolRuntime: 't',
              readOnly: false,
              source: { layer: 'default', name: 'x' },
            },
            sandbox: { provider: 'none', onUnavailable: 'allow', source: { layer: 'default', name: 'x' } },
            compaction: { engine: null, source: { layer: 'default', name: 'x' } },
            persistence: { provider: 'sqlite', source: { layer: 'default', name: 'x' } },
            tools: [],
            mcp: [],
            skills: [...on(3), { id: 'off', enabled: false, reasons: [] }],
            modelAdapters: [],
            childEngines: [],
            childModels: [],
            uiModules: [],
            surfaces: [],
            packages: [],
            plugins: on(2),
            selectedModelAdapters: [],
          },
        }
      })
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 100, rows: 30 })
    const app = new TuiApp({
      session,
      term,
      profile: 'local-dev',
      preset: 'standard',
      model: 'm1',
      welcome: { version: '0.9.3' },
    })
    await app.start()
    return { app, client, term }
  }
  const first = await launch(true)
  await vi.waitFor(async () => {
    const text = (await screenOf(first.term, 100, 30)).join('\n')
    expect(text).toContain('v0.9.3')
    expect(text).toContain('◉ 2 plugins   ◉ 3 skills   ◉ 0 MCP servers')
    expect(text).toMatch(/2h {2}Earlier work/)
  })
  await first.app.stop()
  await first.client.close()
  // A second launch of the same version still draws the full hero, and a failing resource query
  // only leaves its field out.
  const second = await launch(false)
  await vi.waitFor(async () => {
    const text = (await screenOf(second.term, 100, 30)).join('\n')
    expect(text).toContain('local agent workbench')
    expect(text).toContain('What shall we build?')
    expect(text).toMatch(/2h {2}Earlier work/)
  })
  expect((await screenOf(second.term, 100, 30)).join('\n')).not.toContain('plugins')
  await second.app.stop()
  await second.client.close()
})

it('repaints the welcome while it animates and stops the timer with the app', async () => {
  const { endpoint } = fakeSessionEndpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 132, rows: 40 }, { TERM: 'xterm-256color' })
  const app = new TuiApp({
    session,
    term,
    profile: 'local-dev',
    preset: 'standard',
    welcome: { motion: true },
  })
  try {
    await app.start()
    const before = term.writes.length
    // The shine runs at ~60 ms a frame without any input or projection tick.
    await vi.waitFor(() => expect(term.writes.length).toBeGreaterThan(before + 4))
  } finally {
    await app.stop()
  }
  const after = term.writes.length
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(term.writes.length).toBe(after)
  await client.close()
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
    // A short conversation still leaves the input area on the bottom edge, the gap above it.
    expect(statusRow).toBe(19)
    expect(lines.slice(lines.findIndex((l) => l.includes('Agnes')) + 1, editorRow - 1)).toContain('')
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
    // The open picker grows the bottom-anchored input area upward; the footer stays on the last row.
    expect(open.findIndex((line) => line.includes('credits 3000/4000'))).toBe(23)

    term.feed('\t') // The open picker owns unrelated keys too; this must not enter the editor.
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

it('cycles the thinking level on Shift+Tab through setModel, and declines a model without thinking', async () => {
  const usage = (id: string) => ({
    totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    context: { tokens: 10, window: 1_000, autoCompact: false },
    model: { route: 'deepseek', id, thinking: 'low' },
  })
  for (const [id, reasoning] of [
    ['deepseek-v4-pro', true],
    ['deepseek-v4-flash', false],
  ] as const) {
    const endpoint = new FakeEndpoint()
      .on('initialize', () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
      }))
      .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:think' }))
      .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
      .on('_agnes/v1/session.detach', () => ({}))
      .on('_agnes/v1/session.projectUI', () => ({ ...EMPTY_TIMELINE, usage: usage(id) }))
      .on('_agnes/v1/apis.list', () => ({
        profile: {
          name: 'local-dev',
          resolvedProfileHash: 'h',
          presets: { default: 'standard', allowed: ['standard'] },
          models: [{ route: 'deepseek', id, reasoning }],
        },
        families: [],
      }))
      .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 5 }))
    const client = createClient({ transport: { kind: 'inproc', endpoint } })
    let app: TuiApp | undefined
    try {
      const session = await client.session.new({ cwd: '/tmp' })
      const term = new FakeTerminal({ columns: 100, rows: 24 })
      app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
      await app.start()
      term.feed('\x1b[Z')
      if (reasoning) {
        await vi.waitFor(async () =>
          expect((await screenOf(term, 100, 24)).join('\n')).toContain('thinking medium from seq 5'),
        )
        term.feed('\x1b[Z')
        await vi.waitFor(() =>
          expect(endpoint.calls.filter((e) => e.method === '_agnes/v1/session.setModel')).toHaveLength(2),
        )
        const sent = endpoint.calls.filter((e) => e.method === '_agnes/v1/session.setModel')
        expect(sent[0]?.params).toMatchObject({ slot: 'primary', model: id, thinking: 'medium' })
        expect(sent[1]?.params).toMatchObject({ thinking: 'high' })
      } else {
        await vi.waitFor(async () =>
          expect((await screenOf(term, 100, 24)).join('\n')).toContain('no thinking levels'),
        )
        expect(endpoint.calls.some((e) => e.method === '_agnes/v1/session.setModel')).toBe(false)
      }
    } finally {
      await app?.stop()
      await client.close()
      await endpoint.close()
    }
  }
})

it('switches to the next and previous /model entry on Alt+P and Alt+Shift+P through setModel', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:altp' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({ ...EMPTY_TIMELINE }))
    .on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        models: [
          { route: 'r', id: 'one' },
          { route: 'r', id: 'two' },
        ],
      },
      families: [],
    }))
    .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 7 }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 100, rows: 24 })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    const sent = () => endpoint.calls.filter((e) => e.method === '_agnes/v1/session.setModel')
    // Nothing known yet: next starts at the first model, then goes on from it.
    term.feed('\x1bp')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 100, 24)).join('\n')).toContain('model r/one from seq 7'),
    )
    term.feed('\x1bp')
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    term.feed('\x1bP')
    await vi.waitFor(() => expect(sent()).toHaveLength(3))
    expect(sent().map((e) => (e.params as { model: string }).model)).toEqual(['one', 'two', 'one'])
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

    term.feed('\t')
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
      '❯ What do you want to do? Start with a sentence.',
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
  const prefs = mkdtempSync(join(tmpdir(), 'agnes-tui-light-'))
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 60, rows: 20 }, { TERM: 'xterm-256color' })
    // Dark is the default; this surface is the light theme's.
    writeFileSync(join(prefs, 'tui-theme.json'), '{"theme":"light"}')
    app = new TuiApp({
      session,
      term,
      profile: 'local-dev',
      preset: 'standard',
      themePreferencePath: join(prefs, 'tui-theme.json'),
    })
    await app.start()
    await vi.waitFor(async () => expect((await screenOf(term, 60, 20)).join('\n')).toContain('▍ hello agnes'))
    const out = term.writes.join('')
    const light = new TuiTheme('light')
    const sgr = (layer: 'fg' | 'bg', tone: Tone): string =>
      createAnsi('256')
        [layer](light.colour(tone) as Colour, '')
        .slice(0, -'\x1b[39m'.length)
    // The prompt keeps its editor accent; the brand word consumes the resolved branding accent.
    expect(out).toContain(`${sgr('fg', 'accent')}❯ ${sgr('fg', 'fg')}`)
    expect(out).toContain(`\x1b[38;5;63magnes${sgr('fg', 'fg')}`)
    expect(out).toContain(`\x1b[1m\x1b[38;5;63m▍${sgr('fg', 'fg')}\x1b[22m`)
    expect(out).toContain(sgr('bg', 'surface'))
    expect(out).not.toContain('\x1b[38;5;45myou:')
    term.feed('/')
    await vi.waitFor(() => expect(term.writes.join('')).toContain(sgr('bg', 'selection')))
    // Local command output recedes to muted text; only the end of a long /help fits the screen.
    term.feed('help')
    term.feed('\r')
    await vi.waitFor(() =>
      expect(term.writes.join('')).toContain(`${sgr('fg', 'muted')}${SLASH_COMMANDS.at(-1)?.name}`),
    )
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    rmSync(prefs, { recursive: true, force: true })
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
      // The provider alone takes 0.8 s; a loaded runner can push the whole turn past a second.
      expect((await screenOf(term, 80, 24)).join('\n')).toMatch(/✓ turn 1 · [0-9]+\.[0-9]s/)
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
  const ansi = new TuiTheme('mono').ansi(createAnsi('none'))
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
    await vi.waitFor(() => expect(app?.session.id).toContain('s2'))
    await new Promise((resolve) => setTimeout(resolve, 100))

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
    .on('_agnes/v1/submit', () => ({ seq: 2, replayed: false }))
    .on('_agnes/v1/submit.ack', () => ({}))
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

it('input queued in the daemon leaves nothing behind that re-dials after a terminal close', async () => {
  const h = await daemonRestartHarness({ hangPrompt: true })
  try {
    h.term.feed('first')
    h.term.feed('\r')
    await vi.waitFor(async () => expect(await h.screen()).toMatch(spinnerFrames))
    // Busy with a prompt in flight: this one goes to the daemon queue, and this client keeps no timer for it.
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
        decisionRef: { sessionId: 's', id: 'tk-parked', revision: 1 },
      },
    ],
  })
  try {
    await vi.waitFor(async () => expect(await h.screen()).toContain('decision tk-parke'))
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

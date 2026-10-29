import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runTui } from '../src/modes/tui.js'
import { TuiOpening } from '../src/modes/tui-opening.js'
import type { Booted } from '../src/types.js'
import { say } from './boot-host.js'
import { FAKE_SESSION_ID, type FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

async function booted(endpoint: FakeEndpoint): Promise<Booted> {
  const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
  return {
    client,
    profileName: 'local-dev',
    resolvedProfileHash: 'h',
    bootMs: 1,
    form: 'local',
    close: () => client.close(),
  }
}

function tuiIO() {
  const stdin = Object.assign(new PassThrough(), {
    setRawMode: (_raw: boolean) => undefined,
  })
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  return {
    stdin,
    stdout,
    env: { NO_COLOR: '1' },
    cwd: '/w',
    registerCancel: (_cancel: () => Promise<void>) => undefined,
    // End just after the first successful draw. This keeps the test focused on session setup,
    // rather than having an interactive terminal loop hold it open.
    signal: () => 'SIGTERM' as const,
  }
}

describe('runTui model selection', () => {
  it('renders the profile branding returned through the SDK contract', async () => {
    const endpoint = scriptedEndpoint().on('_agnes/v1/apis.list', () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        branding: { accent: '#00875A', mark: 'acme', selfLabel: 'Acme Workbench' },
      },
      families: [],
    }))
    const io = tuiIO()
    let rendered = ''
    io.stdout.on('data', (chunk) => {
      rendered += String(chunk)
    })

    await expect(
      runTui(await booted(endpoint), parseArgs([]), { ...io, agnesVersion: '1.2.3' }),
    ).resolves.toBe(143)
    expect(rendered).toContain('Acme Workbench')
    // The version rides along from the launcher into the welcome.
    expect(rendered).toContain('v1.2.3')
    expect(rendered).not.toContain('Agnes AI')
  })

  it('--no-alt-screen keeps the shell screen: no alternate screen, no mouse reporting, no opening composer', async () => {
    const io = tuiIO()
    let rendered = ''
    io.stdout.on('data', (chunk) => {
      rendered += String(chunk)
    })
    await expect(runTui(await booted(scriptedEndpoint()), parseArgs(['--no-alt-screen']), io)).resolves.toBe(
      143,
    )
    for (const mode of ['1049', '1002', '1006']) expect(rendered).not.toContain(`\x1b[?${mode}`)
    expect(rendered).toContain('\x1b[?2004h')
    expect(rendered).toContain('\x1b[?25h')
  })

  it('propagates AGNES_LOCALE and LANG through runTui into the rendered status chrome', async () => {
    const renderWith = async (env: NodeJS.ProcessEnv): Promise<string> => {
      const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: {
          turn: 1,
          step: 2,
          phase: 'parked',
          parked: {
            decisionRef: { sessionId: FAKE_SESSION_ID, id: 'tk-abcdefgh', revision: 1 },
            expiresAt: '2026-09-12T00:00:00.000Z',
          },
        },
        turns: [],
        nodes: [],
      }))
      const io = tuiIO()
      io.env = { ...io.env, ...env }
      let rendered = ''
      io.stdout.on('data', (chunk) => {
        rendered += String(chunk)
      })
      await expect(runTui(await booted(endpoint), parseArgs([]), io)).resolves.toBe(143)
      await endpoint.close()
      return rendered
    }

    // 语言按 AGNES_LOCALE、LC_ALL、LC_MESSAGES、LANG 的顺序取第一个非空值：中文 LANG 切换为中文。
    const fromLang = await renderWith({ LANG: 'zh_CN.UTF-8' })
    expect(fromLang).toContain('挂起 tk-abcde…')
    const explicitChinese = await renderWith({ AGNES_LOCALE: 'zh-CN', LANG: 'en_US.UTF-8' })
    expect(explicitChinese).toContain('挂起 tk-abcde…')
    const explicitEnglish = await renderWith({ AGNES_LOCALE: 'en', LANG: 'zh_CN.UTF-8' })
    expect(explicitEnglish).toContain('parked tk-abcde…')
    expect(explicitEnglish).not.toContain('挂起 tk-abcde…')
  })

  it('does not replay a stale workspace queue after restart and sends the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-tui-restart-'))
    const { host } = await createTestHost({
      dataDir: dir,
      script: [say('fresh answer one'), say('fresh answer two')],
    })
    const endpoint = createLocalEndpoint(host, { pollMs: 5 })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    let raw = false
    try {
      // This is the session shape old CLI launches reused. Leave a next-turn item in it exactly as
      // the reported failure did, then start the real TUI in the same cwd.
      await client.workspace.add(dir)
      const stale = await client.session.new({ cwd: dir })
      await stale.followUp('stale queued message')

      const stdin = Object.assign(new PassThrough(), {
        setRawMode: (value: boolean) => {
          raw = value
        },
      })
      const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
      let rendered = ''
      stdout.on('data', (chunk) => {
        rendered += String(chunk)
      })
      const running = runTui(
        {
          client,
          profileName: host.profile.name,
          resolvedProfileHash: host.profile.hash ?? 'h',
          bootMs: 1,
          form: 'local',
          close: () => client.close(),
        },
        parseArgs([]),
        {
          stdin,
          stdout,
          env: { NO_COLOR: '1' },
          cwd: dir,
          registerCancel: () => undefined,
          signal: () => undefined,
        },
      )

      await vi.waitFor(() => expect(raw).toBe(true))
      for (const char of 'fresh prompt one') stdin.write(char)
      stdin.write('\r')
      for (const char of 'fresh prompt two') stdin.write(char)
      stdin.write('\r')
      await vi.waitFor(() => expect(rendered).toContain('fresh answer two'))
      expect(rendered).toContain('fresh prompt one')
      expect(rendered).toContain('fresh prompt two')
      expect(rendered).not.toContain('stale queued message')

      stdin.write('\x03')
      stdin.write('\x03')
      await expect(running).resolves.toBe(0)
      // The transcript is not echoed back; after the screen is restored: how long the run lasted, how
      // many messages the session holds, and the line that names the session.
      expect(rendered.slice(rendered.lastIndexOf('\x1b[?1049l'))).toMatch(
        /This run lasted \d+s(?: · messages: \d+)?\n(?:Still waiting.*\n)?Resume this session: agh --resume \S+\n$/,
      )
    } finally {
      await client.close()
      await endpoint.close()
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a fresh conversation instead of reopening the workspace singleton', async () => {
    const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', () => ({
      sessionId: FAKE_SESSION_ID,
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))

    const io = tuiIO()
    Object.assign(io.stdout, { isTTY: true })
    let written = ''
    io.stdout.on('data', (chunk) => {
      written += String(chunk)
    })
    await expect(runTui(await booted(endpoint), parseArgs([]), io)).resolves.toBe(143)
    // Nothing was sent this run, so there is nothing to resume.
    expect(written).not.toContain('agh --resume')

    const call = endpoint.calls.find((entry) => entry.method === 'session/new')
    expect(call?.params).toMatchObject({
      cwd: '/w',
      _meta: {
        'ai.agnes.harness': {
          sessionKey: expect.stringMatching(/^agnes:local:local-dev:cli:session:[0-9a-f-]{36}$/),
        },
      },
    })
  })

  it('sets a chosen model on a new session before starting the app', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 1 }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(
      runTui(await booted(endpoint), parseArgs(['--model', 'primary=chosen-route/chosen-model']), tuiIO()),
    ).resolves.toBe(143)

    const call = endpoint.calls.find((entry) => entry.method === '_agnes/v1/session.setModel')
    expect(call?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
      slot: 'primary',
      route: 'chosen-route',
      model: 'chosen-model',
    })
    expect(
      endpoint.calls.findIndex((entry) => entry.method === '_agnes/v1/session.setModel'),
    ).toBeGreaterThan(endpoint.calls.findIndex((entry) => entry.method === 'session/new'))
  })

  it('narrows the tools of a new or resumed session before the app starts, and stops on an older daemon', async () => {
    for (const argv of [[], ['--resume', FAKE_SESSION_ID]]) {
      const endpoint = scriptedEndpoint()
        .on('_agnes/v1/session.setToolFilter', () => ({ effectiveFromSeq: 1, filter: { deny: ['bash'] } }))
        .on('_agnes/v1/session.projectUI', () => ({
          sessionId: FAKE_SESSION_ID,
          generation: 1,
          upto: 0,
          opState: null,
          turns: [],
          nodes: [],
        }))
      await expect(
        runTui(await booted(endpoint), parseArgs([...argv, '--disallowed-tools', 'bash']), tuiIO()),
      ).resolves.toBe(143)
      const methods = endpoint.calls.map((entry) => entry.method)
      expect(methods.indexOf('_agnes/v1/session.setToolFilter')).toBeGreaterThan(
        methods.indexOf(argv.length ? 'session/load' : 'session/new'),
      )
      expect(methods.indexOf('_agnes/v1/session.setToolFilter')).toBeLessThan(
        methods.indexOf('_agnes/v1/session.projectUIOpening'),
      )
      expect(
        endpoint.calls.find((entry) => entry.method === '_agnes/v1/session.setToolFilter')?.params,
      ).toMatchObject({
        sessionId: FAKE_SESSION_ID,
        deny: ['bash'],
      })
    }

    const older = scriptedEndpoint()
    await expect(runTui(await booted(older), parseArgs(['--tools', 'read']), tuiIO())).rejects.toMatchObject({
      message: expect.stringContaining('cannot limit a session'),
    })
    expect(older.calls.map((entry) => entry.method)).not.toContain('_agnes/v1/session.projectUIOpening')
  })

  it('does not rewrite the historical model of a resumed session', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.setModel', () => ({ effectiveFromSeq: 1 }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(
      runTui(
        await booted(endpoint),
        parseArgs(['--resume', FAKE_SESSION_ID, '--model', 'primary=chosen-route/chosen-model']),
        tuiIO(),
      ),
    ).resolves.toBe(143)

    expect(endpoint.calls.map((entry) => entry.method)).toContain('session/load')
    expect(endpoint.calls.map((entry) => entry.method)).not.toContain('_agnes/v1/session.setModel')
  })

  it('/quit exits while the turn of the initial prompt is still running', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const endpoint = scriptedEndpoint().on('session/prompt', async () => {
      await hold
      return { stopReason: 'end_turn' }
    })
    const io = { ...tuiIO(), signal: () => undefined }
    io.stdout.resume()
    let done = false
    const running = runTui(await booted(endpoint), parseArgs(['--no-alt-screen', 'do', 'it']), io).then(
      (code) => {
        done = true
        return code
      },
    )
    try {
      await vi.waitFor(() => expect(endpoint.calls.map((c) => c.method)).toContain('session/prompt'))
      io.stdin.write('/quit\r')
      await vi.waitFor(() => expect(done).toBe(true))
      await expect(running).resolves.toBe(0)
    } finally {
      release()
    }
  })

  it('--continue loads the most recently active session in this directory', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.list', () => ({
        items: [
          { sessionId: FAKE_SESSION_ID, createdAt: 't', lastSeq: 1, generation: 1, preset: 'standard' },
        ],
      }))
      .on('_agnes/v1/session.projectUI', () => ({
        sessionId: FAKE_SESSION_ID,
        generation: 1,
        upto: 0,
        opState: null,
        turns: [],
        nodes: [],
      }))

    await expect(runTui(await booted(endpoint), parseArgs(['--continue']), tuiIO())).resolves.toBe(143)

    expect(endpoint.calls.find((entry) => entry.method === 'session/load')?.params).toMatchObject({
      sessionId: FAKE_SESSION_ID,
    })
    expect(endpoint.calls.map((entry) => entry.method)).not.toContain('session/new')
  })
})

describe('composer drawn before the session is ready', () => {
  const emptyTimeline = () => ({
    sessionId: FAKE_SESSION_ID,
    generation: 1,
    upto: 0,
    opState: null,
    turns: [],
    nodes: [],
  })
  function opened() {
    const io = tuiIO()
    let rendered = ''
    io.stdout.on('data', (chunk) => {
      rendered += String(chunk)
    })
    let stderr = ''
    const giveUp = vi.fn()
    const opening = new TuiOpening(parseArgs([]), {
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: { write: (s: string) => (stderr += s) },
      env: io.env,
      cwd: io.cwd,
      signals: new EventEmitter(),
      giveUp,
    })
    return { io, opening, rendered: () => rendered, stderr: () => stderr, giveUp }
  }

  it('keeps the draft on Enter before ready, then carries it into the app, where Enter sends it', async () => {
    const endpoint = scriptedEndpoint()
      .on('_agnes/v1/session.projectUI', emptyTimeline)
      .on('session/prompt', () => ({ stopReason: 'end_turn' }))
    const { io, opening, rendered } = opened()
    io.stdin.write('hello draft')
    io.stdin.write('\r')
    await vi.waitFor(() => expect(rendered()).toContain('your draft is kept'))
    expect(endpoint.calls.map((c) => c.method)).not.toContain('session/prompt')
    let signal: 'SIGTERM' | undefined
    const running = runTui(await booted(endpoint), parseArgs([]), {
      ...io,
      signal: () => signal,
      opening,
    })
    try {
      await vi.waitFor(() => expect(endpoint.calls.map((c) => c.method)).toContain('session/new'))
      await vi.waitFor(() => expect(rendered().split('hello draft').length).toBeGreaterThan(2))
      io.stdin.write('\r')
      await vi.waitFor(() => expect(endpoint.calls.map((c) => c.method)).toContain('session/prompt'))
      expect(JSON.stringify(endpoint.calls.find((c) => c.method === 'session/prompt')?.params)).toContain(
        'hello draft',
      )
    } finally {
      signal = 'SIGTERM'
      io.stdin.write('\x03')
      io.stdin.write('\x03')
      await running.catch(() => undefined)
    }
  })

  it('prints the draft, control characters removed, when the start fails', () => {
    const { io, opening, rendered, stderr } = opened()
    io.stdin.write('\x1b[200~keep\x1b[31m this\x1b[201~')
    opening.abandon()
    expect(rendered()).toContain('\x1b[?1049l')
    expect(stderr()).toMatch(/^Unsent draft: keep.*this\n$/)
    expect(stderr()).not.toContain('\x1b')
    opening.abandon()
    expect(stderr().match(/Unsent draft/g)).toHaveLength(1)
  })

  it('marks first-frame, composer-ready and session-ready in order', async () => {
    const endpoint = scriptedEndpoint().on('_agnes/v1/session.projectUI', emptyTimeline)
    const io = tuiIO()
    const env = { ...io.env, AGH_TIMING: '1' }
    const marks: string[] = []
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      marks.push(...[...String(s).matchAll(/^agh-timing (\S+) /gm)].map((m) => m[1] as string))
      return true
    }) as typeof process.stderr.write)
    try {
      const opening = new TuiOpening(parseArgs([]), {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: { write: () => true },
        env,
        cwd: io.cwd,
        signals: new EventEmitter(),
        giveUp: () => undefined,
      })
      await runTui(await booted(endpoint), parseArgs([]), { ...io, env, opening })
    } finally {
      err.mockRestore()
    }
    expect(marks).toEqual(['first-frame', 'composer-ready', 'session-ready'])
  })
})

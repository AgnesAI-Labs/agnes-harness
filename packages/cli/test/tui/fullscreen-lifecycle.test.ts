import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { createClient } from '@agnes/sdk'
import { Terminal as Xterm } from '@xterm/headless'
import { expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/args.js'
import { runTui } from '../../src/modes/tui.js'
import { TuiApp } from '../../src/tui/app.js'
import { Text, VStack } from '../../src/tui/component.js'
import { TuiProjection } from '../../src/tui/projection.js'
import { Renderer } from '../../src/tui/renderer.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { say } from '../boot-host.js'
import { emulate } from './harness.js'

it('runs five real TUI sessions with double Ctrl-C in the same terminal, including resize', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-fullscreen-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: Array.from({ length: 5 }, (_, index) => say(`reply-${index}`)),
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  // Keep this emulator and both streams alive across every CLI invocation. Replaying each run
  // into a fresh emulator would miss exactly the user's retained-terminal failure.
  const xterm = new Xterm({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
  let raw = false
  let writes = Promise.resolve()
  const stdin = Object.assign(new PassThrough(), {
    setRawMode: (value: boolean) => {
      raw = value
    },
  })
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  stdout.on('data', (chunk) => {
    writes = writes.then(() => new Promise<void>((resolve) => xterm.write(String(chunk), resolve)))
  })
  const lines = (kind: 'normal' | 'alternate') => {
    const buffer = xterm.buffer[kind]
    return Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
    )
  }
  let running: Promise<number> | undefined
  let cancel: () => Promise<void> = async () => {}
  try {
    stdout.write('SHELL HISTORY\r\n$ agnes\r\n')
    await writes
    for (let index = 0; index < 5; index++) {
      const before = lines('normal')
      running = runTui(
        {
          client,
          profileName: host.profile.name,
          resolvedProfileHash: host.profile.hash ?? null,
          bootMs: 0,
          form: 'local',
          close: () => client.close(),
        },
        parseArgs([]),
        {
          stdin,
          stdout,
          env: { NO_COLOR: '1' },
          cwd: dir,
          registerCancel: (handler) => {
            cancel = handler
          },
          signal: () => undefined,
        },
      )
      await vi.waitFor(async () => {
        await writes
        expect(raw).toBe(true)
        expect(xterm.buffer.active.type).toBe('alternate')
        expect(lines('alternate').join('\n')).toContain('Agnes AI')
      })
      expect(lines('normal')).toEqual(before)
      expect(lines('alternate').join('\n')).not.toContain('reply-')
      for (const char of `question-${index}`) stdin.write(char)
      stdin.write('\r')
      await vi.waitFor(async () => {
        await writes
        expect(
          lines('alternate').filter((line) => line === `reply-${index}`),
          lines('alternate').join('\n'),
        ).toHaveLength(1)
        expect(lines('alternate').some((line) => line.includes(' · turn '))).toBe(false)
      })
      for (const [columns, rows] of [
        [50, 12],
        [100, 30],
        [80, 24],
      ] as const) {
        await writes
        xterm.resize(columns, rows)
        stdout.columns = columns
        stdout.rows = rows
        stdout.emit('resize')
        await writes
        expect(xterm.buffer.active.type).toBe('alternate')
        expect(lines('normal').join('\n')).not.toContain(`reply-${index}`)
        expect(lines('alternate').filter((line) => line === `reply-${index}`)).toHaveLength(1)
      }
      stdin.write('\x03')
      stdin.write('\x03')
      await expect(running).resolves.toBe(0)
      running = undefined
      await writes
      expect(raw).toBe(false)
      expect(stdin.listenerCount('data')).toBe(0)
      expect(stdout.listenerCount('resize')).toBe(0)
      expect(xterm.buffer.active.type).toBe('normal')
      const history = lines('normal')
      expect(history).toContain('SHELL HISTORY')
      // Exit gives the shell page back exactly as it was: no copy of the chat is written onto it.
      expect(history.filter(Boolean)).toEqual(before.filter(Boolean))
      expect(history.join('\n')).not.toMatch(/reply-|question-|Agnes AI|Ctrl\+C|Enter send|↑0|❯/)
      stdout.write('$ agnes\r\n')
      await writes
    }
  } finally {
    if (running) {
      await cancel()
      await running
    }
    await client.close()
    await endpoint.close()
    await host.close()
    await writes
    xterm.dispose()
    stdin.destroy()
    stdout.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('claims the alternate screen before a slow session open can expose the prior terminal page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-fullscreen-opening-'))
  const { host } = await createTestHost({ dataDir: dir, script: [say('unused')] })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const stdin = Object.assign(new PassThrough(), {
    setRawMode: () => {},
  })
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  let releaseOpen!: () => void
  const opening = new Promise<void>((resolve) => {
    releaseOpen = resolve
  })
  const originalNew = client.session.new.bind(client.session)
  const newSession = vi.spyOn(client.session, 'new').mockImplementation(async (...args) => {
    await opening
    return originalNew(...args)
  })
  let running: Promise<number> | undefined
  let cancel: () => Promise<void> = async () => {}
  try {
    running = runTui(
      {
        client,
        profileName: host.profile.name,
        resolvedProfileHash: host.profile.hash ?? null,
        bootMs: 0,
        form: 'local',
        close: () => client.close(),
      },
      parseArgs([]),
      {
        stdin,
        stdout,
        env: { NO_COLOR: '1' },
        cwd: dir,
        registerCancel: (handler) => {
          cancel = handler
        },
        signal: () => undefined,
      },
    )
    await vi.waitFor(() => expect(output).toBe('\x1b[?1049h\x1b[H\x1b[2J'))
    releaseOpen()
    await vi.waitFor(() => expect(output).toContain('Agnes AI'))
    stdin.write('\x03')
    stdin.write('\x03')
    await expect(running).resolves.toBe(0)
    running = undefined
    expect(output).toContain('\x1b[?1049l\x1b[?25h')
  } finally {
    newSession.mockRestore()
    if (running) {
      await cancel()
      await running
    }
    await client.close()
    await endpoint.close()
    await host.close()
    stdin.destroy()
    stdout.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('restores the screen and raw mode when the first render fails', async () => {
  const term = new FakeTerminal({ columns: 30, rows: 5 })
  term.write('shell before start')
  const renderer = new Renderer(term, {
    render() {
      throw new Error('broken view')
    },
    invalidate() {},
  })
  expect(() => renderer.start()).toThrow('broken view')
  expect(term.raw).toBe(false)
  expect((await emulate(term, 30, 5)).lines[0]).toBe('shell before start')
})

it('leaves raw mode even if writing the final transcript fails', () => {
  const term = new FakeTerminal({ columns: 30, rows: 5 })
  const renderer = new Renderer(term, new VStack([new Text('live')]))
  renderer.start()
  const write = vi
    .spyOn(term, 'write')
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('output closed')
    })
  expect(() => renderer.stop(['answer'])).toThrow('output closed')
  expect(term.raw).toBe(false)
  write.mockRestore()
})

it('restores the shell before a rejected projection teardown, and /new clears old exit text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-fullscreen-cleanup-'))
  const { host } = await createTestHost({ dataDir: dir, script: [say('old reply')] })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  await client.workspace.add(dir)
  const session = await client.session.new({ cwd: dir })
  const app = new TuiApp({ session, term, profile: host.profile.name })
  try {
    await app.start()
    await app.submit('old question')
    await vi.waitFor(async () => expect((await emulate(term, 80, 24)).lines).toContain('old reply'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    try {
      await app.command('/new')
    } finally {
      cwd.mockRestore()
    }
    expect((await emulate(term, 80, 24)).lines.join('\n')).not.toContain('old reply')
    const stop = TuiProjection.prototype.stop
    const spy = vi.spyOn(TuiProjection.prototype, 'stop').mockImplementationOnce(async function (
      this: TuiProjection,
    ) {
      expect(term.raw).toBe(false)
      await stop.call(this)
      throw new Error('teardown failed')
    })
    try {
      await expect(app.stop()).rejects.toThrow('teardown failed')
      expect(term.raw).toBe(false)
      const screen = await emulate(term, 80, 24)
      expect([...screen.scrollback, ...screen.lines].join('\n')).not.toContain('old reply')
    } finally {
      spy.mockRestore()
    }
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import type { RequestBody } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { say } from '../boot-host.js'
import { emulate } from './harness.js'

const COLS = 60
const ROWS = 18

it('--no-alt-screen writes finished turns once, in order, into scrollback above a bottom footer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-split-footer-'))
  const { host } = await createTestHost({
    dataDir: dir,
    script: [say('first answer\x1b[2J'), say('second answer')],
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: COLS, rows: ROWS })
    term.cursor = { row: 1, col: 1 }
    app = new TuiApp({ session, term, header: 'Agnes', noAltScreen: true })
    await app.start()
    for (const [question, answer] of [
      ['first question', 'first answer'],
      ['second question', 'second answer'],
    ] as const) {
      term.feed(question)
      term.feed('\r')
      await vi.waitFor(async () => {
        const screen = await emulate(term, COLS, ROWS)
        expect([...screen.scrollback, ...screen.lines].join('\n')).toContain(answer)
        expect(app?.busy).toBe(false)
      })
    }
    // Mouse reporting and paging are off here: the wheel and PgUp belong to the terminal.
    term.feed('\x1b[5~')
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    const all = term.writes.join('')
    for (const forbidden of ['\x1b[?1049', '\x1b[?1002', '\x1b[?1006', '\x1b[3J', '\x1b[2J'])
      expect(all).not.toContain(forbidden)

    const screen = await emulate(term, COLS, ROWS)
    const text = [...screen.scrollback, ...screen.lines].filter((line) => line.trim() !== '')
    const at = (needle: string) => text.findIndex((line) => line.includes(needle))
    expect(text.filter((line) => line.includes('first question'))).toHaveLength(1)
    expect(text.filter((line) => line.includes('second answer'))).toHaveLength(1)
    expect(text.some((line) => line.includes('first answer'))).toBe(true)
    expect(at('first question')).toBeLessThan(at('first answer'))
    expect(at('first answer')).toBeLessThan(at('second question'))
    expect(at('second question')).toBeLessThan(at('second answer'))
    // The prompt and status stay on the last rows, with the conversation above them.
    expect(screen.lines.slice(-6).join('\n')).toContain('What do you want to do?')
    expect(screen.lines.slice(0, ROWS - 6).join('\n')).not.toContain('What do you want to do?')

    await app.stop()
    const after = await emulate(term, COLS, ROWS)
    expect(
      [...after.scrollback, ...after.lines].filter((line) => line.includes('second answer')),
    ).toHaveLength(1)
    expect(term.raw).toBe(false)
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('--no-alt-screen opens and closes the slash menu above the prompt without disturbing written turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-split-footer-'))
  const { host } = await createTestHost({ dataDir: dir, script: [say('menu answer')] })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: COLS, rows: ROWS })
    term.cursor = { row: 1, col: 1 }
    app = new TuiApp({ session, term, header: 'Agnes', noAltScreen: true })
    await app.start()
    term.feed('hello')
    term.feed('\r')
    await vi.waitFor(async () => {
      const screen = await emulate(term, COLS, ROWS)
      expect([...screen.scrollback, ...screen.lines].join('\n')).toContain('menu answer')
      expect(app?.busy).toBe(false)
    })
    const before = await emulate(term, COLS, ROWS)
    term.feed('/')
    await vi.waitFor(async () => {
      const open = await emulate(term, COLS, ROWS)
      expect(open.lines.length).toBe(ROWS)
      expect(open.lines.join('\n')).toContain('/help')
    })
    term.feed('\x1b')
    await vi.waitFor(async () => {
      const closed = await emulate(term, COLS, ROWS)
      expect(closed.lines.join('\n')).not.toContain('/help')
    })
    const after = await emulate(term, COLS, ROWS)
    const kept = (screen: { scrollback: string[]; lines: string[] }) =>
      [...screen.scrollback, ...screen.lines].filter(
        (line) => line.includes('hello') || line.includes('menu answer'),
      )
    expect(kept(after)).toEqual(kept(before))
    expect(after.lines.at(-1)).toContain('session')
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('--no-alt-screen commits a long streamed reply block by block: every paragraph once, in order, before the turn ends', async () => {
  const paragraphs = Array.from(
    { length: 9 },
    (_, i) => `Paragraph ${i} ${'words go here and wrap onto more rows '.repeat(3).trim()}`,
  )
  const reply = paragraphs.join('\n\n')
  const dir = mkdtempSync(join(tmpdir(), 'agnes-split-footer-'))
  const { host } = await createTestHost({
    dataDir: dir,
    provider: {
      models: () => [],
      async *infer(req: RequestBody) {
        yield { type: 'sent', stamp: stampFor(req) }
        // Streams in uneven pieces, with a pause, so previews reach the TUI between them.
        for (let at = 0; at < reply.length; at += 37) {
          yield { type: 'text_delta', delta: reply.slice(at, at + 37) }
          await new Promise((resolve) => setTimeout(resolve, 15))
        }
        yield { type: 'done', reason: 'stop' }
      },
    },
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: COLS, rows: ROWS })
    term.cursor = { row: 1, col: 1 }
    app = new TuiApp({ session, term, header: 'Agnes', noAltScreen: true })
    await app.start()
    term.feed('tell me')
    term.feed('\r')
    let committedWhileRunning = false
    const count = (screen: { scrollback: string[]; lines: string[] }, marker: string) =>
      [...screen.scrollback, ...screen.lines].filter((line) => line.includes(marker)).length
    await vi.waitFor(
      async () => {
        const screen = await emulate(term, COLS, ROWS)
        if (
          app?.busy &&
          count(screen, 'Paragraph 0') > 0 &&
          screen.scrollback.join('').includes('Paragraph 0')
        )
          committedWhileRunning = true
        for (const marker of paragraphs.map((_, i) => `Paragraph ${i} `))
          expect(count(screen, marker)).toBeLessThanOrEqual(1)
        expect(count(screen, 'Paragraph 8 ')).toBe(1)
        expect(app?.busy).toBe(false)
      },
      { timeout: 15_000, interval: 10 },
    )
    const screen = await emulate(term, COLS, ROWS)
    const text = [...screen.scrollback, ...screen.lines]
    const order = paragraphs.map((_, i) => text.findIndex((line) => line.includes(`Paragraph ${i} `)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(committedWhileRunning).toBe(true)
    expect(text.join(' ').replace(/\s+/g, ' ')).toContain(paragraphs[8]?.replace(/\s+/g, ' '))
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

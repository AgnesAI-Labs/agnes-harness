import type { SessionJob } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { BangShell } from '../src/bang-shell.js'
import { BusyInput } from '../src/busy-input.js'
import type { Component } from '../src/component.js'
import { Editor } from '../src/editor.js'
import { PASTE_END, PASTE_START } from '../src/keys.js'
import { rootInput } from '../src/root-input.js'

const job = (over: Partial<SessionJob> = {}): SessionJob => ({
  id: 'job-1',
  owner: 'human',
  ownerSessionId: 's1',
  kind: 'shell',
  command: 'ls',
  cwd: '/work',
  status: 'running',
  code: null,
  truncated: false,
  ...over,
})

/** A fake daemon: `jobsRun` answers with a running job, `jobsRead` walks through `reads`. */
function harness(reads: SessionJob[], options: { remote?: boolean; run?: () => Promise<SessionJob> } = {}) {
  const notices: Array<[string, string]> = []
  const cards: Component[] = []
  const controls: unknown[] = []
  const commands: string[] = []
  const delays: number[] = []
  const editor = new Editor({ onSubmit: () => {} })
  let gate: (() => void) | undefined
  let hold = false
  let now = 1_000
  const session = {
    id: 's1',
    jobsRun: async (command: string) => {
      commands.push(command)
      return (options.run ?? (async () => job()))()
    },
    jobsRead: async () => ({ jobs: [], completions: [], job: reads.shift() }),
    jobsControl: async (input: unknown) => {
      controls.push(input)
      return { output: { ok: true } }
    },
  }
  const busyInput = new BusyInput({
    session: () => app.session,
    locale: () => 'en',
    notice: () => {},
    restore: (draft) => editor.setText(draft),
  })
  const app = {
    locale: 'en',
    stopped: false,
    session,
    editor,
    busyInput,
    o: { remote: options.remote ?? false },
    statusBar: { setNotice: (text: string, tone: string) => notices.push([text, tone]) },
    renderer: { requestRender: () => {} },
    timeline: { appendLocal: (_id: string, view: Component) => cards.push(view) },
    localCommandView: (command: string, output: string): Component => ({
      render: () => [command, ...output.split('\n')],
      invalidate: () => {},
    }),
    showError: (error: unknown) => notices.push([String(error), 'error']),
  } as unknown as TuiApp
  const shell = new BangShell(app, {
    sleep: async (ms) => {
      delays.push(ms)
      if (hold) await new Promise<void>((resolve) => (gate = resolve))
    },
    now: () => (now += 500),
  })
  return {
    app,
    shell,
    notices,
    cards,
    controls,
    commands,
    delays,
    editor,
    busyInput,
    holdPolling: () => {
      hold = true
    },
    release: () => {
      hold = false
      gate?.()
    },
    screen: () => (cards[0]?.render(80) ?? []).join('\n'),
  }
}

/** Every control character except newline. */
const controls = (text: string) =>
  [...text].filter((ch) => {
    const code = ch.charCodeAt(0)
    return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
  })

const done = (over: Partial<SessionJob> = {}) => job({ status: 'completed', code: 0, ...over })

describe('! and !! shell lines', () => {
  it('!ls shows a card with output and the exit code, then sends a [Shell #1] chip with the next message', async () => {
    const h = harness([job({ stdout: 'a\n' }), done({ stdout: 'a\nb\n', stderr: 'warn\n' }), done()])
    await h.shell.run('!ls -la')
    expect(h.commands).toEqual(['ls -la'])
    const card = h.screen()
    expect(card).toContain('$ ls -la')
    expect(card).toContain('a\nb\nwarn')
    expect(card).toContain('exit 0 · ')
    // 250 ms first, backing off but never past 1 s.
    expect(h.delays[0]).toBe(250)
    expect(Math.max(...h.delays)).toBeLessThanOrEqual(1000)
    expect(h.editor.text).toBe('[Shell #1]')
    const blocks = h.busyInput.takeKept('[Shell #1] why did it fail?')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('[Shell #1]')
    expect(text).toContain('$ ls -la')
    expect(text).toContain('exit code 0')
    expect(text).toContain('a\nb\nwarn')
    // A chip deleted from the draft sends nothing.
    await h.shell.run('!pwd')
    expect(h.editor.text).toContain('[Shell #2]')
    expect(h.busyInput.takeKept('no chip left')).toEqual([])
  })

  it('!!ls shows the card but makes no chip', async () => {
    const h = harness([done({ stdout: 'x\n' })])
    await h.shell.run('!!ls')
    expect(h.commands).toEqual(['ls'])
    expect(h.screen()).toContain('x')
    expect(h.editor.text).toBe('')
    expect(h.busyInput.takeKept('[Shell #1]')).toEqual([])
  })

  it('Ctrl-C sends SIGINT, a second one kills, and an idle shell leaves the key alone', async () => {
    const h = harness([done()])
    expect(h.shell.interrupt()).toBe(false)
    h.holdPolling()
    const running = h.shell.run('!sleep 99')
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.shell.interrupt()).toBe(true)
    expect(h.shell.interrupt()).toBe(true)
    expect(h.controls).toEqual([
      { operation: 'signal', signal: 'SIGINT', jobId: 'job-1' },
      { operation: 'kill', jobId: 'job-1' },
    ])
    h.release()
    await running
    expect(h.shell.interrupt()).toBe(false)
  })

  it('refuses a second command while one runs, and keeps the draft', async () => {
    const h = harness([done()])
    h.holdPolling()
    const first = h.shell.run('!sleep 99')
    await new Promise((resolve) => setImmediate(resolve))
    await h.shell.run('!ls')
    expect(h.commands).toEqual(['sleep 99'])
    expect(h.notices.at(-1)?.[0]).toMatch(/still running/)
    expect(h.editor.text).toBe('!ls')
    h.release()
    await first
  })

  it('refuses a second command submitted while the first is still starting', async () => {
    let started: (value: SessionJob) => void = () => {}
    const h = harness([done()], { run: () => new Promise<SessionJob>((resolve) => (started = resolve)) })
    const first = h.shell.run('!sleep 99')
    await new Promise((resolve) => setImmediate(resolve))
    await h.shell.run('!ls')
    expect(h.commands).toEqual(['sleep 99'])
    expect(h.notices.at(-1)?.[0]).toMatch(/still running/)
    expect(h.editor.text).toBe('!ls')
    started(job())
    await first
  })

  it.each([
    [
      'an older daemon without the operation',
      { code: -32601, data: { code: 'METHOD_NOT_FOUND' } },
      /does not support ! commands/,
    ],
    [
      'one that rejects the unknown operation',
      { code: -32602, data: { code: 'ENUM' } },
      /does not support ! commands/,
    ],
    [
      'a session that may not run commands',
      { code: -32006, data: { code: 'CAPABILITY_DENIED' } },
      /does not allow running commands/,
    ],
  ])('says so for %s, shows no card and brings the draft back', async (_name, error, notice) => {
    const h = harness([], { run: async () => Promise.reject(error) })
    await h.shell.run('!ls')
    expect(h.notices.at(-1)?.[0]).toMatch(notice)
    expect(h.cards).toEqual([])
    expect(h.editor.text).toBe('!ls')
    expect(h.busyInput.takeKept('[Shell #1]')).toEqual([])
  })

  it('refuses an empty or oversized command without calling the daemon', async () => {
    const h = harness([])
    await h.shell.run('!  ')
    await h.shell.run(`!${'x'.repeat(8193)}`)
    expect(h.commands).toEqual([])
    expect(h.notices.map(([text]) => text)).toEqual([
      'type a command after !',
      'that command is longer than 8192 bytes',
    ])
  })

  it('strips control characters and escape sequences from the command, the card and the chip', async () => {
    const dirty = 'one\u001b[31mred\u001b[0m\u0007 \u001b]0;title\u0007\nprogress 1\rprogress 2\tend\u0085\n'
    const h = harness([done({ stdout: dirty })])
    await h.shell.run('!echo \u001b[31mhi\u0007')
    const card = h.screen()
    expect(controls(card)).toEqual([])
    expect(card).toContain('$ echo hi')
    expect(card).toContain('onered')
    expect(card).toContain('progress 2    end')
    expect(card).not.toContain('progress 1')
    expect(card).not.toContain('title')
    const text = (h.busyInput.takeKept('[Shell #1]')[0] as { text: string }).text
    expect(controls(text)).toEqual([])
    expect(text).toContain('$ echo hi')
  })

  it('keeps the last 16 KiB for the chip and says what was cut', async () => {
    const big = `${'head\n'.repeat(10_000)}tail-marker\n`
    const h = harness([done({ stdout: big, truncated: true })])
    await h.shell.run('!big')
    const text = (h.busyInput.takeKept('[Shell #1]')[0] as { text: string }).text
    expect(text).toContain('tail-marker')
    expect(text).toContain('earlier output was cut')
    expect(text).toContain('capture limit reached')
    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024 + 600)
  })

  it('labels a remote run as running on the daemon host', async () => {
    const remote = harness([done()], { remote: true })
    await remote.shell.run('!ls')
    expect(remote.screen()).toContain('runs on the daemon host')
    const local = harness([done()])
    await local.shell.run('!ls')
    expect(local.screen()).not.toContain('daemon host')
  })

  it('reports a killed command and a command it lost track of', async () => {
    const killed = harness([job({ status: 'killed', code: -1, stdout: 'partial' })])
    await killed.shell.run('!sleep 999')
    expect(killed.screen()).toContain('stopped (exit -1)')
    expect((killed.busyInput.takeKept('[Shell #1]')[0] as { text: string }).text).toContain(
      'stopped before it finished',
    )
    const lost = harness([])
    await lost.shell.run('!ls')
    expect(lost.screen()).toContain('lost track of the command')
    expect(lost.editor.text).toBe('')
  })
})

describe('the prompt glyph', () => {
  it('shows ! while the draft starts with !', () => {
    const editor = new Editor({ onSubmit: () => {} })
    expect(editor.render(40)[0]).toContain('❯')
    editor.setText('!ls')
    const row = editor.render(40)[0] ?? ''
    expect(row).toContain('! ')
    expect(row).not.toContain('❯')
    editor.setText('ls !')
    expect(editor.render(40)[0]).toContain('❯')
  })
})

describe('only the typed draft makes a shell line', () => {
  const submitted: Array<{ text: string; raw: string; chips: boolean }> = []
  const editorWith = () => {
    submitted.length = 0
    return new Editor({ onSubmit: (text, raw, chips) => submitted.push({ text, raw, chips }) })
  }
  const pasted = ['!rm -rf ~', ...Array.from({ length: 12 }, (_, n) => `line ${n}`)].join('\n')

  it('hands a submit the typed draft, so a pasted block that starts with ! stays a prompt', () => {
    const editor = editorWith()
    editor.handleInput(`${PASTE_START}${pasted}${PASTE_END}`)
    expect(editor.text).toMatch(/^\[/)
    editor.handleInput('\r')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.text.startsWith('!rm -rf ~')).toBe(true)
    expect(submitted[0]?.raw.startsWith('!')).toBe(false)
    expect(submitted[0]?.chips).toBe(true)
  })

  it('refuses a typed ! line that holds a chip, and never calls the daemon', async () => {
    const editor = editorWith()
    editor.handleInput('!echo ')
    editor.handleInput(`${PASTE_START}${pasted}${PASTE_END}`)
    editor.handleInput('\r')
    const { raw, chips } = submitted[0] as { raw: string; chips: boolean }
    expect(raw.startsWith('!echo ')).toBe(true)
    expect(chips).toBe(true)
    const h = harness([])
    await h.shell.run(raw, chips)
    expect(h.commands).toEqual([])
    expect(h.notices.at(-1)?.[0]).toMatch(/expand or remove pasted blocks/)
  })

  it('steering while busy follows the same rule', () => {
    const runs: unknown[][] = []
    const steers: string[] = []
    const steer = (editor: Editor) => {
      const host = {
        signals: () => ({ focus: () => false }),
        settle: { press: () => false },
        modal: { handleInput: () => false },
        dialogs: [],
        closed: () => false,
        approvalCards: new Map(),
        latestApproval: () => undefined,
        cards: { handleInput: () => false },
        timeline: { jumpKey: () => false },
        noAltScreen: true,
        busy: () => true,
        refuseClosed: () => false,
        editor,
        steer: async (text: string) => void steers.push(text),
        runInput: async (...args: unknown[]) => void runs.push(args),
        showError: () => {},
      }
      rootInput(host as never, () => false)('\u001b\r')
    }
    const chipped = new Editor({ onSubmit: () => {} })
    chipped.handleInput(`${PASTE_START}${pasted}${PASTE_END}`)
    steer(chipped)
    expect(runs).toEqual([])
    expect(steers).toHaveLength(1)
    const typed = new Editor({ onSubmit: () => {} })
    typed.handleInput('!ls')
    steer(typed)
    expect(runs).toEqual([['!ls', '!ls', false]])
    const mixed = new Editor({ onSubmit: () => {} })
    mixed.handleInput('!echo ')
    mixed.handleInput(`${PASTE_START}${pasted}${PASTE_END}`)
    steer(mixed)
    expect(runs[1]?.[2]).toBe(true)
    expect(steers).toHaveLength(1)
  })
})

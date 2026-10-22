import { dirname, join } from 'node:path'
import { SIGNAL_EXIT_CODES, type SignalName } from '../errors.js'
import { timingMark } from '../timing.js'
import { ProvisionalComposer } from '../tui/app.js'
import { resolveLocale } from '../tui/locale.js'
import { type InputStream, NodeTerminal, type OutputStream } from '../tui/terminal.js'
import type { ParsedArgs } from '../types.js'
import { refuseWhatCannotBeHonoured } from './print.js'

/** The first stdout write after this is the first frame; costs nothing without AGH_TIMING. */
export function markFirstFrame(io: { stdout: OutputStream; env: NodeJS.ProcessEnv }): void {
  if (io.env.AGH_TIMING !== '1') return
  const write = io.stdout.write
  io.stdout.write = (s: string) => {
    io.stdout.write = write
    timingMark('first-frame', io.env)
    return write.call(io.stdout, s)
  }
}

/**
 * The composer on screen before the daemon is reached. It owns the alternate screen and the keyboard
 * until `runTui` takes both over (`release`), or until something ends the start (`abandon`, which
 * gives the terminal back and prints what was typed).
 */
export class TuiOpening {
  readonly term: NodeTerminal
  private readonly composer: ProvisionalComposer
  private readonly off: Array<() => void> = []
  private open = true
  /** The exit code, once Ctrl-C or a signal ended the start; the caller stops opening the session. */
  gaveUp: number | undefined

  constructor(
    p: ParsedArgs,
    private readonly io: {
      stdin: InputStream
      stdout: OutputStream
      stderr: { write(s: string): unknown }
      env: NodeJS.ProcessEnv
      cwd: string
      composerSelectionPath?: string
      signals: NodeJS.EventEmitter
      giveUp(code: number): void
    },
  ) {
    refuseWhatCannotBeHonoured(p)
    this.term = new NodeTerminal(io.stdin, io.stdout, io.env)
    this.composer = new ProvisionalComposer(this.term, {
      locale: resolveLocale(io.env),
      cwd: io.cwd,
      ...(io.composerSelectionPath
        ? { themePreferencePath: join(dirname(io.composerSelectionPath), 'tui-theme.json') }
        : {}),
      onInterrupt: () => this.interrupt(SIGNAL_EXIT_CODES.SIGINT),
    })
    // No ladder exists yet: a signal would end the process with the terminal still in raw mode.
    for (const name of Object.keys(SIGNAL_EXIT_CODES) as SignalName[]) {
      const handler = (): void => this.interrupt(SIGNAL_EXIT_CODES[name])
      io.signals.on(name, handler)
      this.off.push(() => io.signals.off(name, handler))
    }
    markFirstFrame(io)
    this.composer.start()
    timingMark('composer-ready', io.env)
  }

  private interrupt(code: number): void {
    this.gaveUp = code
    this.abandon()
    this.io.giveUp(code)
  }

  private close(): boolean {
    if (!this.open) return false
    this.open = false
    for (const off of this.off.splice(0)) off()
    return true
  }

  /** Hands the screen and the keyboard to the app that takes over, and returns the draft. */
  release(): string {
    return this.close() ? this.composer.release() : ''
  }

  /** Gives the terminal back with the draft printed, for a start that failed or was interrupted. */
  abandon(): void {
    if (!this.close()) return
    const line = this.composer.abandon()
    if (line) this.io.stderr.write(`${line}\n`)
  }

  /** Gives the terminal back for a prompt that needs the normal screen; the draft comes along unprinted. */
  stash(): string {
    if (!this.close()) return ''
    const draft = this.composer.draft
    this.composer.abandon()
    return draft
  }
}

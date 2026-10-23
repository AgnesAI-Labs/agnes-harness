import type { SessionJob } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { chipText, cleanShellText, outputOf, parseBang, tailRows } from './bang-format.js'
import type { Component } from './component.js'
import type { BangKey } from './locale-bang.js'
import { tt } from './locale-extended.js'

export { isBangLine } from './bang-format.js'

const MAX_COMMAND_BYTES = 8192
const POLL_START_MS = 250
const POLL_MAX_MS = 1000
const LOST_AFTER = 3

type Clock = { sleep(ms: number): Promise<void>; now(): number }
const realClock: Clock = { sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: Date.now }

const code = (error: unknown) => (error as { code?: unknown } | null)?.code
const dataCode = (error: unknown) => (error as { data?: { code?: unknown } } | null)?.data?.code
/** An older daemon has no such operation: it answers method-not-found, or rejects the params it does not know. */
const unsupported = (error: unknown) =>
  code(error) === -32601 || code(error) === -32602 || dataCode(error) === 'METHOD_NOT_FOUND'
const denied = (error: unknown) => code(error) === -32006 || dataCode(error) === 'CAPABILITY_DENIED'

/**
 * `!cmd` and `!!cmd` in the prompt: one shell command at a time, run by the daemon as a human-owned
 * session job. The timeline card follows the job by polling; `!cmd` then hands its result to the next
 * message as a `[Shell #N]` chip, `!!cmd` keeps it local.
 */
export class BangShell {
  private running: { session: Session; jobId: string; presses: number } | undefined
  private count = 0

  constructor(
    private readonly app: TuiApp,
    private readonly clock: Clock = realClock,
  ) {}

  /** Ctrl-C while a command runs: SIGINT first, then kill. False when nothing runs, so Ctrl-C keeps its usual job. */
  interrupt(): boolean {
    const run = this.running
    if (!run) return false
    const first = run.presses++ === 0
    this.say(first ? 'bang.interrupted' : 'bang.killing', 'warning')
    const stop = first
      ? ({ operation: 'signal', signal: 'SIGINT' } as const)
      : ({ operation: 'kill' } as const)
    void run.session.jobsControl({ ...stop, jobId: run.jobId }).catch((error) => this.app.showError(error))
    return true
  }

  /** `text` is the draft as typed; `chips` says it held a paste or image chip, which a shell line never expands. */
  async run(text: string, chips = false): Promise<void> {
    const { app } = this
    const { local, command } = parseBang(text)
    const refuse = (key: BangKey, vars?: Record<string, string | number>): void => {
      // The draft comes back: nothing ran, and the line may be long.
      app.editor.setText(text)
      this.say(key, 'error', vars)
    }
    if (chips) return this.say('bang.chips', 'error')
    if (!command) return refuse('bang.empty')
    if (command.includes('\0') || Buffer.byteLength(command) > MAX_COMMAND_BYTES)
      return refuse('bang.tooLong', { max: MAX_COMMAND_BYTES })
    if (this.running) return refuse('bang.busy')
    const session = app.session
    let job: SessionJob
    try {
      job = await session.jobsRun(command)
    } catch (error) {
      if (unsupported(error)) return refuse('bang.unsupported')
      if (denied(error)) return refuse('bang.denied')
      app.editor.setText(text)
      throw error
    }
    this.running = { session, jobId: job.id, presses: 0 }
    const started = this.clock.now()
    const label = app.o.remote ? `  (${tt('bang.remote', app.locale)})` : ''
    const title = `$ ${cleanShellText(command)}${label}`
    let view = app.localCommandView(title, tt('bang.running', app.locale))
    const card: Component = {
      render: (width) => view.render(width),
      transcript: (width) => (view.transcript ?? view.render).call(view, width),
      invalidate: () => view.invalidate(),
    }
    app.timeline.appendLocal(session.id, card)
    const paint = (seen: SessionJob, footer: string): void => {
      const rows = tailRows(outputOf(seen))
      const omitted = rows.omitted ? [tt('bang.omitted', app.locale, { n: rows.omitted })] : []
      view = app.localCommandView(title, [...omitted, rows.text, footer].filter(Boolean).join('\n'))
      if (!app.stopped) app.renderer.requestRender()
    }
    try {
      const final = await this.follow(session, job, paint)
      if (!final) return
      const seconds = (this.clock.now() - started) / 1000
      const secs = seconds.toFixed(1)
      paint(
        final,
        final.status === 'killed'
          ? tt('bang.stopped', app.locale, { code: final.code ?? -1, secs })
          : final.code === null
            ? tt('bang.noExit', app.locale, { secs })
            : tt('bang.exit', app.locale, { code: final.code, secs }),
      )
      // A session switch while it ran leaves the result with the old session: no chip then.
      if (local || app.session !== session) return
      const chip = tt('bang.chip', app.locale, { n: ++this.count })
      app.busyInput.attach(chip, { type: 'text', text: chipText(chip, command, final, seconds) }, session.id)
      app.editor.insertChip(chip)
      this.say('bang.attached', 'success', { chip })
    } finally {
      this.running = undefined
    }
  }

  /** Reads the job until it ends: every 250 ms at first, backing off to 1 s. Undefined when it was lost or the TUI stopped. */
  private async follow(
    session: Session,
    job: SessionJob,
    paint: (seen: SessionJob, footer: string) => void,
  ): Promise<SessionJob | undefined> {
    const running = tt('bang.running', this.app.locale)
    let delay = POLL_START_MS
    let failures = 0
    let last = job
    for (;;) {
      await this.clock.sleep(delay)
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5))
      if (this.app.stopped) return undefined
      try {
        const seen = (await session.jobsRead(job.id)).job
        if (!seen) throw new Error('JOB_NOT_FOUND')
        failures = 0
        last = seen
        if (seen.status !== 'running') return seen
        paint(seen, running)
      } catch (error) {
        if (++failures < LOST_AFTER) continue
        const reason = cleanShellText(error instanceof Error ? error.message : String(error))
        paint(last, tt('bang.lost', this.app.locale, { reason }))
        return undefined
      }
    }
  }

  private say(
    key: BangKey,
    tone: 'error' | 'success' | 'warning',
    vars?: Record<string, string | number>,
  ): void {
    if (this.app.stopped) return
    this.app.statusBar.setNotice(tt(key, this.app.locale, vars), tone)
    this.app.renderer.requestRender()
  }
}

import { type Component, CURSOR_MARKER, escapeControl, wrapText } from '../component.js'
import { type Box, dialogBox } from '../components/box.js'
import { FilterSelect } from '../components/filter-select.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { McpLoginPanelOutcome, McpLoginPanelUi, TuiMcpLogin } from '../mcp-login-port.js'
import type { ThemedAnsi } from '../theme.js'
import { SecretInputView } from './secret-input.js'
import type { NoticeTone } from './status-bar.js'

const ESC = '\x1b'
const CTRL_Y = '\x19'

export type McpLoginInit = {
  port: TuiMcpLogin
  profile: string
  /** Absent: the user picks one of `candidates` first. */
  serverId?: string
  candidates?: readonly string[]
  /** Hands text to the clipboard (with the terminal's own fallback). */
  copy(text: string): void
}

type Hint = { key: string; label: string }

/** What one sign-in has to show; the panel draws it again whenever it changes. */
type Run = {
  serverId: string
  progress: string
  url?: string
  paste?: SecretInputView
  /** The final message of a sign-in that stays on screen until it is closed. */
  done?: { text: string; tone: NoticeTone }
  /** Esc closed the panel; a late result then only leaves a notice. */
  dismissed: boolean
  controller: AbortController
}

/**
 * `/mcp login`: one transient dialog with the progress, the authorization address (copyable) and a box to
 * paste the address the browser ended on. The sign-in itself runs behind the injected port; Esc aborts it.
 */
export class McpLoginPanel implements Component {
  #box: Box | undefined
  #init: McpLoginInit | undefined
  #run: Run | undefined

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale: string
      maxRows(): number
      notice(text: string | undefined, tone?: NoticeTone): void
      changed(): void
    },
  ) {}

  get open(): boolean {
    return this.#box !== undefined
  }

  show(init: McpLoginInit): void {
    this.close()
    this.#init = init
    if (init.serverId !== undefined) this.#start(init.serverId)
    else this.#pick(init.candidates ?? [])
  }

  /** Ends the panel and any sign-in it is running (the app is leaving, or another dialog took over). */
  close(): void {
    this.#run?.controller.abort()
    this.#run = undefined
    this.#init = undefined
    if (this.#box) {
      this.#box = undefined
      this.o.changed()
    }
  }

  invalidate(): void {
    this.#box?.invalidate()
  }

  handleInput(data: string): boolean {
    if (!this.#box) return false
    this.#box.handleInput(data)
    return true
  }

  render(width: number): string[] {
    return this.#box?.render(width) ?? []
  }

  #t(key: Parameters<typeof tt>[0], vars?: Record<string, string | number>): string {
    return tt(key, this.o.locale, vars)
  }

  #frame(title: string, child: Component, hints: readonly Hint[]): void {
    this.#box = dialogBox(child, { title, ansi: this.o.ansi, hints })
    this.o.notice(undefined)
    this.o.changed()
  }

  #pick(candidates: readonly string[]): void {
    const select = new FilterSelect({
      options: candidates.map((id) => ({ id, label: escapeControl(id), search: id })),
      locale: this.o.locale,
      ansi: this.o.ansi,
      maxRows: () => Math.max(1, this.o.maxRows() - 3),
      onChoose: (id) => this.#start(id),
      onCancel: () => this.close(),
    })
    this.#frame(this.#t('mcpLogin.pickTitle'), select, [
      { key: '↑↓', label: this.#t('dialog.select') },
      { key: '⏎', label: this.#t('dialog.confirm') },
      { key: 'esc', label: this.#t('dialog.close') },
    ])
  }

  #start(serverId: string): void {
    const init = this.#init
    if (!init) return
    const run: Run = {
      serverId,
      progress: this.#t('mcpLogin.starting'),
      dismissed: false,
      controller: new AbortController(),
    }
    this.#run = run
    this.#draw(run)
    const ui: McpLoginPanelUi = {
      show: ({ authorizationUrl }) => {
        if (this.#run !== run || run.dismissed) return
        run.url = authorizationUrl
        run.progress = this.#t('mcpLogin.waiting')
        this.#draw(run)
      },
      paste: (signal) =>
        new Promise<string | undefined>((resolve) => {
          if (this.#run !== run || run.dismissed || signal.aborted) return resolve(undefined)
          const end = () => {
            if (run.paste === input) delete run.paste
            resolve(undefined)
            if (this.#run === run && !run.dismissed) this.#draw(run)
          }
          const input = new SecretInputView({
            locale: this.o.locale,
            label: this.#t('mcpLogin.pasteLabel'),
            hint: this.#t('mcpLogin.pasteHint'),
            masked: false,
            allowEmpty: true,
            onSubmit: (text) => {
              signal.removeEventListener('abort', end)
              delete run.paste
              resolve(text)
              this.#draw(run)
            },
            onBack: () => this.#dismiss(run),
          })
          signal.addEventListener('abort', end, { once: true })
          run.paste = input
          this.#draw(run)
        }),
      progress: (text) => {
        if (this.#run !== run || run.dismissed) return
        run.progress = escapeControl(text)
        this.#draw(run)
      },
    }
    init.port.login({ profile: init.profile, serverId, ui, signal: run.controller.signal }).then(
      (outcome) => this.#finished(run, outcome),
      (error) => this.#failed(run, error),
    )
  }

  #finished(run: Run, outcome: McpLoginPanelOutcome): void {
    if (this.#run !== run) return
    const server = escapeControl(run.serverId)
    if (outcome.reconnectFailed !== undefined) {
      const error = escapeControl(outcome.reconnectFailed)
      this.#end(run, this.#t('mcpLogin.reconnectFailed', { server, error }), 'warning')
    } else if (outcome.kind === 'cancelled') this.#end(run, this.#t('mcpLogin.cancelled'), 'info')
    else if (outcome.kind === 'timed-out') this.#end(run, this.#t('mcpLogin.timedOut'), 'warning')
    else {
      const key = outcome.kind === 'signed-in' ? 'mcpLogin.signedIn' : 'mcpLogin.alreadySignedIn'
      this.#end(run, this.#t(key, { server }), 'success')
    }
  }

  #failed(run: Run, error: unknown): void {
    if (this.#run !== run) return
    this.#end(run, escapeControl(error instanceof Error ? error.message : String(error)), 'error')
  }

  /** A short result is a notice; a failure stays in the panel, which has the room to read it. */
  #end(run: Run, text: string, tone: NoticeTone): void {
    if (run.dismissed) {
      // Esc already showed "cancelled"; only a result that is not that is news.
      if (text !== this.#t('mcpLogin.cancelled')) this.o.notice(text, tone)
      this.#run = undefined
      return
    }
    delete run.paste
    if (tone === 'error' || tone === 'warning') {
      run.done = { text, tone }
      this.#draw(run)
      return
    }
    this.#run = undefined
    this.#box = undefined
    this.o.changed()
    this.o.notice(text, tone)
  }

  /** Esc: close the panel now, stop the sign-in, and say so. */
  #dismiss(run: Run): void {
    if (this.#run !== run || run.dismissed) return
    run.dismissed = true
    run.controller.abort()
    this.#box = undefined
    this.o.changed()
    this.o.notice(this.#t('mcpLogin.cancelled'), 'info')
  }

  #hints(run: Run): Hint[] {
    if (run.done) return [{ key: 'esc', label: this.#t('dialog.close') }]
    return [
      ...(run.url ? [{ key: 'ctrl+y', label: this.#t('mcpLogin.copy') }] : []),
      ...(run.paste ? [{ key: '⏎', label: this.#t('dialog.confirm') }] : []),
      { key: 'esc', label: this.#t('mcpLogin.cancel') },
    ]
  }

  #draw(run: Run): void {
    if (this.#run !== run || run.dismissed) return
    const { ansi } = this.o
    const body: Component = {
      invalidate: () => {},
      handleInput: (data) => this.#key(run, data),
      render: (width) => {
        if (run.done) {
          const tone = run.done.tone === 'error' ? 'danger' : 'warning'
          return wrapText(run.done.text, width).map((l) => fitLine(ansi.fg(tone, l), width))
        }
        return [
          ...wrapText(run.progress, width).map((l) => fitLine(l, width)),
          ...(run.url
            ? [
                '',
                ...wrapText(escapeControl(run.url), width).map((l) => fitLine(ansi.fg('accent', l), width)),
                '',
              ]
            : []),
          // The input marks its cursor for a host that places the terminal cursor; a dialog has none.
          ...(run.paste?.render(width).map((line) => line.replaceAll(CURSOR_MARKER, '')) ?? []),
        ]
      },
    }
    this.#frame(this.#t('mcpLogin.title', { server: escapeControl(run.serverId) }), body, this.#hints(run))
  }

  #key(run: Run, data: string): boolean {
    if (run.done) {
      if (data === ESC || data === '\r') this.close()
      return true
    }
    if (data === ESC) {
      this.#dismiss(run)
      return true
    }
    if (data === CTRL_Y && run.url) {
      this.#init?.copy(run.url)
      return true
    }
    return run.paste?.handleInput(data) ?? true
  }
}

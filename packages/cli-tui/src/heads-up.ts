import type { UITimeline } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'

const METHOD = '_agnes/v1/clientModules.callService'
const ROW = 'web:builtin:agnes/heads-up'
const MAX_NOTE = 300
const POLL_MS = 1000
const POLL_MAX = 25

type Read = { enabled?: boolean; busy?: boolean; turn?: number; text?: string }
type CallApp = Pick<TuiApp, 'session' | 'profile'>

/** One line, no control or bidi characters, capped: the note is model-written text. */
export function cleanNote(text: string): string {
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(line).slice(0, MAX_NOTE).join('')
}

async function call(app: CallApp, service: string, input: Record<string, boolean | number>): Promise<Read> {
  const { session: s } = app
  const result = await s.client.call<{ output?: Read }>(METHOD, {
    profile: app.profile,
    rowId: ROW,
    sessionId: s.id,
    service,
    input,
  })
  return result.output ?? {}
}

const unavailable = (error: unknown): boolean => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code
  return code === 'METHOD_NOT_FOUND' || code === 'CAPABILITY_DENIED'
}

/** `/heads-up [on|off]`: turns the side-review heads-up on or off for this session, or says which it is. */
export async function headsUpSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale } = app
  const arg = line.trim().split(/\s+/).slice(1)
  if (arg.length > 1 || (arg[0] !== undefined && arg[0] !== 'on' && arg[0] !== 'off'))
    return { text: tt('headsUp.usage', locale) }
  try {
    const state = await (arg[0] === undefined
      ? call(app, 'headsup.read', {})
      : call(app, 'headsup.set', { enabled: arg[0] === 'on' }))
    if (state.enabled === undefined || (arg[0] !== undefined && state.enabled !== (arg[0] === 'on')))
      return { text: tt('headsUp.unsupported', locale) }
    return { text: tt(state.enabled ? 'headsUp.on' : 'headsUp.off', locale) }
  } catch (error) {
    if (unavailable(error)) return { text: tt('headsUp.unsupported', locale) }
    throw error
  }
}

/**
 * After each turn ends, asks the extension for that turn's heads-up and shows it on the status
 * line. The side review can still be running when the turn ends, so it is read until it settles.
 * A session where heads-up is off answers once and the watcher goes quiet again.
 */
export class HeadsUpWatcher {
  private active = false
  private turn = 0
  private run = 0
  private shown: string | undefined

  constructor(
    private readonly app: () => TuiApp | undefined,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Fed every projected timeline; acts on the edge where a running turn becomes idle. */
  onTimeline(timeline: UITimeline): void {
    if (timeline.opState !== null) {
      this.active = true
      this.turn = timeline.opState.turn
      this.run++
      return
    }
    if (!this.active) return
    this.active = false
    void this.poll(this.turn, this.run).catch(() => undefined)
  }

  private async poll(turn: number, run: number): Promise<void> {
    const app = this.app()
    if (!app || turn < 1) return
    const sessionId = app.session.id
    for (let i = 0; i < POLL_MAX && this.run === run && app.session.id === sessionId; i++) {
      let state: Read
      try {
        state = await call(app, 'headsup.read', { turn })
      } catch {
        return
      }
      if (this.run !== run || app.session.id !== sessionId || !state.enabled) return
      const note = state.text ? cleanNote(state.text) : ''
      if (note && note !== this.shown) {
        this.shown = note
        app.statusBar.setNotice(`${tt('headsUp.label', app.locale)}: ${note}`, 'warning')
        app.renderer.requestRender()
      }
      if (!state.busy) return
      await this.sleep(POLL_MS)
    }
  }
}

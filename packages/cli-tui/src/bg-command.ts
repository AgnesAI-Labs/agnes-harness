import type { TurnEndReason } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SessionChoice, SlashResult } from './commands.js'
import { inheritFreshSession } from './composer-memory.js'
import { tt } from './locale-extended.js'
import type { NotifyEvent } from './notify.js'
import { oneLine } from './session-commands.js'
import { freshTuiSessionKey } from './session-key.js'
import { signalsFor } from './terminal-signals.js'
import type { NoticeTone } from './views/status-bar.js'

export type BackgroundState = 'running' | 'waiting' | 'done' | 'error' | 'stopped'
type Entry = { n: number; session: Session; title: string; startedAt: number; state: BackgroundState }

const MAX_PROMPT = 16_000
const MAX_RUNNING = 5
const TITLE = 60

// The background sessions this TUI process started, oldest first. Not persisted: another run does not know them.
const started = new WeakMap<TuiApp, Entry[]>()
const live = (entry: Entry): boolean => entry.state === 'running' || entry.state === 'waiting'

/** A turn that parks is waiting for an approval; anything that is not a normal end, a failure or a park was stopped. */
export const stateOf = (reason: TurnEndReason): BackgroundState =>
  reason === 'completed' ? 'done' : reason === 'parked' ? 'waiting' : reason === 'error' ? 'error' : 'stopped'

const SAID: Record<Exclude<BackgroundState, 'running'>, { tone: NoticeTone; event: NotifyEvent }> = {
  done: { tone: 'success', event: 'done' },
  stopped: { tone: 'warning', event: 'done' },
  waiting: { tone: 'warning', event: 'approval' },
  error: { tone: 'error', event: 'error' },
}

/** The background sessions still going (running, or parked on an approval), for the exit summary. */
export function backgroundSessions(app: TuiApp): { id: string; state: 'running' | 'waiting' }[] {
  return (started.get(app) ?? [])
    .filter(live)
    .map((entry) => ({ id: entry.session.id, state: entry.state as 'running' | 'waiting' }))
}

function finish(app: TuiApp, entry: Entry, state: BackgroundState): void {
  entry.state = state
  if (state === 'running') return
  const said = SAID[state]
  const text = tt('bg.notice', app.locale, {
    n: entry.n,
    state: tt(`bg.state.${state}`, app.locale),
    title: entry.title,
  })
  app.statusBar.setNotice(text, said.tone)
  app.renderer.requestRender()
  // The terminal bell or desktop notification of batch 28, through the same unfocused-only gate.
  signalsFor(app.o.term)?.event(said.event)
}

/**
 * `/bg PROMPT`: a new session in this workspace that gets PROMPT while this one stays open. It is made the
 * way `/new` makes one (same call, same remembered model and permission) and is never given more access
 * than this session has. It registers no permission handler, so a tool that needs approval parks the turn
 * until someone opens the session and answers; nothing is approved for it. Its end is said in the status
 * bar and, when the window is in the background, through the `/notify` channel. `/bg` alone lists them.
 */
export async function bgSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session: s } = app
  const prompt = line.trim().slice('/bg'.length).trim()
  const entries = started.get(app) ?? []
  started.set(app, entries)
  if (!prompt) {
    if (entries.length === 0) return { text: tt('bg.none', locale) }
    const rows = entries.map(
      (e) => `${e.n}. ${tt(`bg.state.${e.state}`, locale)}  ${oneLine(e.session.id)}  ${e.title}`,
    )
    const sessionChoices: SessionChoice[] = entries.map((e) => ({
      sessionId: e.session.id,
      createdAt: new Date(e.startedAt).toISOString(),
      lastSeq: 0,
      preset: null,
      title: `${e.n}. ${e.title}`,
    }))
    return {
      text: rows.join('\n'),
      presentation: 'transcript',
      sessionChoices,
      sessionPickerTitle: 'bg.picker',
    }
  }
  if (prompt.length > MAX_PROMPT) return { text: tt('bg.tooLong', locale, { max: MAX_PROMPT }) }
  if (entries.filter(live).length >= MAX_RUNNING)
    return { text: tt('bg.tooMany', locale, { max: MAX_RUNNING }) }
  const created = await s.client.session.new({ cwd: app.cwd, sessionKey: freshTuiSessionKey(app.profile) })
  await inheritFreshSession(created, app.composerSelectionPath, undefined, locale)
  // The remembered "full access" choice is for sessions the user opens; a background one never exceeds this session.
  const [here, there] = await Promise.all([
    s.projectUIOpening({ surface: 'tui' }),
    created.projectUIOpening({ surface: 'tui' }),
  ])
  if (there.timeline.yolo && !here.timeline.yolo) await created.setYolo(false)
  const entry: Entry = {
    n: entries.length + 1, // no await from here to the push below, so two /bg never share a number
    session: created,
    title: [...oneLine(prompt)].slice(0, TITLE).join(''),
    startedAt: Date.now(),
    state: 'running',
  }
  entries.push(entry)
  created.prompt(prompt).then(
    (result) => finish(app, entry, stateOf(result.reason)),
    () => finish(app, entry, 'error'),
  )
  return { text: tt('bg.started', locale, { n: entry.n, id: oneLine(created.id), title: entry.title }) }
}

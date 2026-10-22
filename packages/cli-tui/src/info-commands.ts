import { dirname } from 'node:path'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { listSessionChoices } from './commands.js'
import { escapeControl } from './component.js'
import { formatUsdMicros } from './format-usage.js'
import { tt } from './locale-extended.js'
import { waitingIn } from './queue-commands.js'
import { oneLine } from './session-commands.js'

const NONE = '-'

/** `/status`: what the footer and /cost, /context and /queue know, on one screen. A source that fails shows `-`. */
async function statusSlash(app: TuiApp): Promise<SlashResult> {
  const { locale, session: s } = app
  const [opening, choices, state] = await Promise.allSettled([
    s.projectUIOpening({ surface: 'tui', maxNodes: 1 }),
    listSessionChoices(s),
    s.controls(),
  ])
  const timeline = opening.status === 'fulfilled' ? opening.value.timeline : undefined
  const mine = choices.status === 'fulfilled' ? choices.value.find((c) => c.sessionId === s.id) : undefined
  const usage = timeline?.usage
  const cost = usage?.cost
    ? formatUsdMicros(usage.cost.usdMicros)
    : usage?.credits
      ? `${usage.credits.amount} credits`
      : NONE
  const context = usage
    ? `${usage.context.tokens} / ${usage.context.window} (${((usage.context.tokens / usage.context.window) * 100).toFixed(1)}%)`
    : NONE
  const remote = app.o.remote ?? false
  // The personal commands directory is `<AGH_HOME>/commands`; no separate home option is passed.
  const home = app.o.commandsDir && dirname(app.o.commandsDir)
  const rows: Array<[Parameters<typeof tt>[0], string]> = [
    ['status.session', oneLine(mine?.title ? `${s.id} · ${mine.title}` : s.id)],
    ['status.preset', oneLine(mine?.preset ?? NONE)],
    ['status.model', usage ? `${usage.model.route}/${usage.model.id} (${usage.model.thinking})` : NONE],
    ['status.cwd', oneLine(app.cwd)],
    // Over --connect this machine's home is not the daemon's: showing it would mislead.
    ['status.home', home && !remote ? oneLine(home) : NONE],
    ['status.connection', tt(remote ? 'status.remote' : 'status.local', locale)],
    ['status.context', context],
    ['status.cost', cost],
    ['status.queued', state.status === 'fulfilled' ? String(waitingIn(state.value.pending).length) : NONE],
    ['status.yolo', timeline ? tt(timeline.yolo ? 'status.on' : 'status.off', locale) : NONE],
  ]
  const labels = rows.map(([key]) => tt(key, locale))
  const width = Math.max(...labels.map((label) => [...label].length))
  return {
    text: rows.map(([, value], i) => `${(labels[i] as string).padEnd(width, ' ')}  ${value}`).join('\n'),
    presentation: 'transcript',
  }
}

/** The assistant replies of the open session, oldest first (streamed text is not in the projection yet). */
async function replies(app: TuiApp): Promise<string[]> {
  const { timeline } = await app.session.projectUIOpening({ surface: 'tui' })
  return timeline.nodes.flatMap((node) => (node.kind === 'assistant' && node.text ? [node.text] : []))
}

// ponytail: only ``` fences; a ~~~ fence is copied as part of the reply, add it when someone asks.
const lastCodeBlock = (text: string): string | undefined =>
  [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].at(-1)?.[1]?.replace(/\n$/, '')

/** `/copy [n|code]`: hands the text to the same clipboard path a mouse selection uses, which shows its own tip. */
async function copySlash(app: TuiApp, args: string[]): Promise<SlashResult> {
  const { locale } = app
  const arg = args[0]
  if (args.length > 1 || (arg !== undefined && arg !== 'code' && !/^[1-9]\d{0,5}$/.test(arg)))
    return { text: tt('copy.usage', locale) }
  const all = await replies(app)
  const n = arg === undefined || arg === 'code' ? 1 : Number(arg)
  if (all.length === 0) return { text: tt('copy.none', locale) }
  if (n > all.length) return { text: tt('copy.range', locale, { n: all.length }) }
  const reply = all[all.length - n] as string
  const text = arg === 'code' ? lastCodeBlock(reply) : reply
  if (text === undefined) return { text: tt('copy.noCode', locale) }
  app.mouse.copy(text)
  return {}
}

const MAX_DIFF_ROWS = 120
const SHOWN_DIFFS = 3

/** `/diff [turn] [path]`: the daemon's own unified diffs. Colouring happens in the transcript view. */
async function diffSlash(app: TuiApp, args: string[]): Promise<SlashResult> {
  const { locale, session: s } = app
  const scope = args[0] === 'turn' ? 'turn' : 'session'
  const path = (scope === 'turn' ? args.slice(1) : args).join(' ')
  const list = await s.workspaceChanges({ scope, ...(path ? { path } : {}) })
  if (list.files.length === 0)
    return {
      text:
        tt(scope === 'turn' ? 'diff.noneTurn' : 'diff.none', locale) +
        (list.unrecorded ? `\n${tt('diff.unrecorded', locale)}` : ''),
    }
  const note = { binary: 'diff.binary', 'too-large': 'diff.tooLarge', 'diff-limit': 'diff.limit' } as const
  const total = (key: 'added' | 'removed') => list.files.reduce((sum, f) => sum + (f[key] ?? 0), 0)
  const out = [
    tt('diff.header', locale, { n: list.files.length, added: total('added'), removed: total('removed') }),
  ]
  for (const f of list.files) {
    const why = [
      f.diffStatus === 'available' ? '' : tt(note[f.diffStatus], locale),
      f.freshness === 'changed' ? tt('diff.changed', locale) : '',
    ].filter(Boolean)
    out.push(
      `  +${f.added ?? '?'} -${f.removed ?? '?'} ${escapeControl(f.path)}${why.length ? ` (${why.join(', ')})` : ''}`,
    )
  }
  // The list carries no diff text: ask for the first few files one by one, or for the one path named.
  const wanted = path
    ? list.files
    : list.files.filter((f) => f.diffStatus === 'available').slice(0, SHOWN_DIFFS)
  for (const f of wanted) {
    const diff = (await s.workspaceChanges({ scope, path: f.path })).selected?.diff
    if (!diff) continue
    const rows = escapeControl(diff).replace(/\n$/, '').split('\n')
    out.push('', `── ${escapeControl(f.path)}`, ...rows.slice(0, path ? undefined : MAX_DIFF_ROWS))
    if (!path && rows.length > MAX_DIFF_ROWS)
      out.push(tt('diff.more', locale, { n: rows.length - MAX_DIFF_ROWS }))
  }
  if (list.truncated) out.push('', tt('diff.truncated', locale))
  if (list.unrecorded) out.push(tt('diff.unrecorded', locale))
  return { text: out.join('\n'), presentation: 'transcript' }
}

/** The small commands that report on the session or hand work to the agent. */
export async function infoSlash(app: TuiApp, cmd: string, line: string): Promise<SlashResult> {
  const args = line.trim().split(/\s+/).slice(1)
  switch (cmd) {
    case '/status':
      return statusSlash(app)
    case '/copy':
      return copySlash(app, args)
    case '/diff':
      return diffSlash(app, args)
    default:
      return {}
  }
}

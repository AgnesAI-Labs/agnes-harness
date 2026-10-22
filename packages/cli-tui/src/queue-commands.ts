import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { codeOf, rejectedCode, textOf } from './busy-input.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const PREVIEW_COLUMNS = 80

/** One inert line per queued message: what the user typed is shown, never interpreted. */
export function queueLine(blocks: readonly ContentBlock[], n: number, locale: string): string {
  const text = [...oneLine(textOf(blocks))]
  const extra = blocks.filter((b) => b.type !== 'text').length
  return tt('queue.row', locale, {
    n,
    text: text.length > PREVIEW_COLUMNS ? `${text.slice(0, PREVIEW_COLUMNS - 1).join('')}…` : text.join(''),
    extra: extra > 0 ? tt('queue.extra', locale, { count: extra }) : '',
  })
}

type Queued = Awaited<ReturnType<Session['controls']>>['pending'][number]

const waitingIn = (pending: readonly Queued[]) =>
  pending.filter((item) => item.kind === 'follow_up' || item.kind === 'steer')

/** A refusal the daemon gave to a queue action, as text; undefined for anything that is not one. */
function refusal(error: unknown, locale: string): string | undefined {
  const code = codeOf(error)
  if (code === 'QUEUED_INPUT_GONE') return tt('queue.gone', locale)
  if (code === 'CAPABILITY_DENIED') return tt('queue.denied', locale)
  if (code === 'CONTROL_NOT_RUNNING') return tt('queue.notRunning', locale)
  const rejected = rejectedCode(error)
  return rejected ? tt('queue.rejected', locale, { code: rejected }) : undefined
}

/**
 * /queue lists the inputs waiting in the daemon behind the running turn, Enter's follow-ups and Alt+Enter's
 * steers. The numbers are read afresh on every command: `edit <n>` takes one back into the editor (its
 * attachments are sent with the next message), `drop <n>` discards it, `now <n>` stops the turn and runs it
 * first and `steer <n>` turns it into guidance for the turn. `last` stands for the newest one (Alt+Up).
 */
export async function queueSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  const found = /^\/queue(?:\s+(edit|drop|now|steer)\s+(\S+))?$/.exec(line.trim())
  if (!found) return { text: tt('queue.usage', locale) }
  const [, verb, key = ''] = found
  const session = app.session
  const state = await session.controls()
  const waiting = waitingIn(state.pending)
  if (verb === undefined)
    return {
      text: waiting.length
        ? waiting.map((item, i) => queueLine(item.content, i + 1, locale)).join('\n')
        : tt('queue.none', locale),
    }
  const n = key === 'last' ? waiting.length : /^\d+$/.test(key) ? Number(key) : 0
  const target = n >= 1 ? waiting[n - 1] : undefined
  if (!target)
    return {
      text: key === 'last' ? tt('queue.none', locale) : tt('queue.unknown', locale, { key: oneLine(key) }),
    }
  const gate = verb === 'now' ? state.controls.interrupt : verb === 'steer' ? state.controls.steer : true
  if (!gate) return { text: tt('queue.unavailable', locale, { verb }) }
  const opts = { commandId: randomUUID() }
  try {
    if (verb === 'now') await session.sendNow(target.itemId, opts)
    else if (verb === 'steer') await session.promoteQueued(target.itemId, opts)
    else await session.removeQueued(target.itemId, opts)
  } catch (error) {
    const text = refusal(error, locale)
    if (text === undefined) throw error
    return { text }
  }
  if (verb !== 'edit')
    return {
      text: tt(`queue.${verb === 'drop' ? 'dropped' : verb === 'now' ? 'sentNow' : 'steered'}`, locale, {
        n,
      }),
    }
  // The editor holds text only: attachments and file links stay aside and go out with the next message.
  const keep = target.content.filter((b) => b.type !== 'text')
  return {
    text:
      tt('queue.edited', locale, { n }) +
      (keep.length ? tt('queue.extra', locale, { count: keep.length }) : ''),
    draft: textOf(target.content),
    ...(keep.length ? { keep } : {}),
  }
}

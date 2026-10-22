import type { ContentBlock } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const PREVIEW_COLUMNS = 80
const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')

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

/**
 * /queue lists the messages typed during a turn that wait for it to end; /queue edit <n> moves one back
 * into the editor and /queue drop <n> discards it. Only this client's own queue is touched: nothing
 * reaches the daemon, and a message already being sent is no longer in it.
 */
export function queueSlash(app: TuiApp, line: string): SlashResult {
  const locale = app.locale
  const queue = app.pendingPrompts
  const found = /^\/queue(?:\s+(edit|drop)\s+(\S+))?$/.exec(line.trim())
  if (!found) return { text: tt('queue.usage', locale) }
  const [, verb, key = ''] = found
  if (verb === undefined)
    return {
      text: queue.length
        ? queue.map((b, i) => queueLine(b, i + 1, locale)).join('\n')
        : tt('queue.none', locale),
    }
  const n = /^\d+$/.test(key) ? Number(key) : 0
  const target = n >= 1 ? queue[n - 1] : undefined
  if (!target) return { text: tt('queue.unknown', locale, { key: oneLine(key) }) }
  // Attachments and file links cannot be put back into the editor as text.
  if (verb === 'edit' && target.some((b) => b.type !== 'text'))
    return { text: tt('queue.attached', locale, { n }) }
  queue.splice(n - 1, 1)
  return verb === 'edit'
    ? { text: tt('queue.edited', locale, { n }), draft: textOf(target) }
    : { text: tt('queue.dropped', locale, { n }) }
}

import type { ContentBlock } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import { textOf } from './busy-input.js'
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

/** /queue lists the inputs waiting in the daemon behind the running turn: Enter's follow-ups and Alt+Enter's steers. */
export async function queueSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  if (line.trim() !== '/queue') return { text: tt('queue.usage', locale) }
  const { pending } = await app.session.controls()
  const waiting = pending.filter((item) => item.kind === 'follow_up' || item.kind === 'steer')
  return {
    text: waiting.length
      ? waiting.map((item, i) => queueLine(item.content, i + 1, locale)).join('\n')
      : tt('queue.none', locale),
  }
}

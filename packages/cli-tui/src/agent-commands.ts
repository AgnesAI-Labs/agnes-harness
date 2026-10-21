import type { SessionControlledChild } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

/** One inert line per child: ids and provider names come from agents and plugins, never trusted. */
export function agentLine(c: SessionControlledChild, n: number, locale: string): string {
  return tt('agents.row', locale, {
    n,
    id: oneLine(c.id),
    status: c.status,
    provider: oneLine(c.providerId),
    time: c.durationMs === null ? '-' : `${(c.durationMs / 1000).toFixed(1)}s`,
    tokens: c.totalTokens ?? '-',
    controls: [c.controls.stop && 'stop', c.controls.continue && 'resume'].filter(Boolean).join(' ') || '-',
  })
}

/**
 * /agents lists the subagents this session can control; /agents stop <n|id> interrupts one and
 * /agents resume <n|id> <message> sends it more work. The daemon decides what is allowed: its refusal
 * is thrown to the caller and shown as it comes.
 */
export async function agentsSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  const s = app.session
  const found = /^\/agents(?:\s+(stop|resume)\s+(\S+)(?:\s+(\S[\s\S]*))?)?$/.exec(line.trim())
  const [, verb, key = '', message] = found ?? []
  // Stopping takes no message; a continuation needs one of its own, and the daemon refuses an empty one.
  if (!found || (verb === 'stop' && message !== undefined) || (verb === 'resume' && message === undefined))
    return { text: tt('agents.usage', locale) }
  const { children = [] } = await s.controls()
  if (verb === undefined)
    return {
      text: children.length
        ? children.map((c, i) => agentLine(c, i + 1, locale)).join('\n')
        : tt('agents.none', locale),
    }
  const n = /^\d+$/.test(key) ? Number(key) : 0
  const target = children.find((c) => c.id === key) ?? (n >= 1 ? children[n - 1] : undefined)
  if (!target) return { text: tt('agents.unknown', locale, { key: oneLine(key) }) }
  if (verb === 'stop') await s.stopChild(target.id)
  else await s.continueChild(target.id, message ?? '')
  return {
    text: tt(verb === 'stop' ? 'agents.stopped' : 'agents.resumed', locale, { id: oneLine(target.id) }),
  }
}

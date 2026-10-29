import type { SessionJob } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const COMMAND_COLUMNS = 80

/** One inert line per job: the command line is whatever the shell was given, never trusted. */
export function jobLine(job: SessionJob, n: number, locale: string): string {
  const command = [...oneLine(job.command)]
  return tt('jobs.row', locale, {
    n,
    command:
      command.length > COMMAND_COLUMNS
        ? `${command.slice(0, COMMAND_COLUMNS - 1).join('')}…`
        : command.join(''),
    status: job.status,
    kind: job.kind,
    owner: job.owner,
    exit: job.code === null ? '' : tt('jobs.exit', locale, { code: job.code }),
  })
}

/**
 * /jobs lists this session's background jobs; /jobs stop <n|id> kills one. `kill` is the only stop the
 * protocol has, and the daemon decides what may be killed (it refuses jobs an agent owns): its refusal
 * is thrown to the caller and shown as it comes.
 */
export async function jobsSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  const s = app.session
  const found = /^\/jobs(?:\s+stop\s+(\S+))?$/.exec(line.trim())
  if (!found) return { text: tt('jobs.usage', locale) }
  const key = found[1]
  const { jobs } = await s.jobsRead()
  if (key === undefined)
    return {
      text: jobs.length ? jobs.map((j, i) => jobLine(j, i + 1, locale)).join('\n') : tt('jobs.none', locale),
    }
  const n = /^\d+$/.test(key) ? Number(key) : 0
  const target = jobs.find((j) => j.id === key) ?? (n >= 1 ? jobs[n - 1] : undefined)
  if (!target) return { text: tt('jobs.unknown', locale, { key: oneLine(key) }) }
  const { output } = await s.jobsControl({ operation: 'kill', jobId: target.id })
  // The Web panel treats `ok: false` as a refusal too.
  if ((output as { ok?: unknown }).ok === false)
    return { text: tt('jobs.refused', locale, { id: oneLine(target.id) }) }
  return { text: tt('jobs.stopped', locale, { id: oneLine(target.id) }) }
}

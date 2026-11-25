import type { SessionJob } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'
import { displayWidth } from './terminal.js'

const COMMAND_COLUMNS = 80
const MIN_COMMAND_COLUMNS = 8

type ShownJobsSnapshot = {
  sessionId: string
  byIndex: Map<number, string>
}

const shownJobs = new WeakMap<object, ShownJobsSnapshot>()

const ZH_STATUS: Record<SessionJob['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已终止',
}

const ZH_KIND: Record<SessionJob['kind'], string> = {
  shell: '命令',
  'shell-session': '终端会话',
  pty: '终端',
  child: '子任务',
}

const ZH_OWNER: Record<SessionJob['owner'], string> = {
  human: '用户',
  agent: '智能体',
}

/** Clip text by terminal display columns (handling CJK wide chars & combining marks). */
export function clipToColumns(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return ''
  if (displayWidth(text) <= maxColumns) return text
  if (maxColumns === 1) return '…'
  const budget = maxColumns - 1
  let out = ''
  for (const ch of text) {
    if (displayWidth(out + ch) > budget) break
    out += ch
  }
  return `${out}…`
}

function localizedJobMeta(job: SessionJob, locale: string) {
  if (locale === 'zh-CN') {
    return {
      status: ZH_STATUS[job.status] ?? job.status,
      kind: ZH_KIND[job.kind] ?? job.kind,
      owner: ZH_OWNER[job.owner] ?? job.owner,
    }
  }
  return { status: job.status, kind: job.kind, owner: job.owner }
}

/** One inert line per job: the command line is whatever the shell was given, never trusted. */
export function jobLine(job: SessionJob, n: number, locale: string, terminalColumns?: number): string {
  const { status, kind, owner } = localizedJobMeta(job, locale)
  const exit = job.code === null ? '' : tt('jobs.exit', locale, { code: job.code })
  const chromeWidth = displayWidth(tt('jobs.row', locale, { n, command: '', status, kind, owner, exit }))
  const commandBudget =
    terminalColumns !== undefined && terminalColumns > 0
      ? Math.max(MIN_COMMAND_COLUMNS, Math.min(COMMAND_COLUMNS, terminalColumns - chromeWidth))
      : COMMAND_COLUMNS
  const command = clipToColumns(oneLine(job.command), commandBudget)
  return tt('jobs.row', locale, { n, command, status, kind, owner, exit })
}

function staleIndexMessage(locale: string, n: number, id?: string): string {
  if (locale === 'zh-CN') {
    return id
      ? `编号 ${n} 对应的任务（${oneLine(id)}）已不在列表中，请重新执行 /jobs 刷新`
      : `尚无当前会话的 /jobs 编号快照，请先执行 /jobs 再按编号操作`
  }
  return id
    ? `job #${n} (${oneLine(id)}) is no longer in the list; run /jobs to refresh`
    : `no recent /jobs listing for this session; run /jobs first before stopping by number`
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
  if (key === undefined) {
    const byIndex = new Map<number, string>()
    for (const [i, job] of jobs.entries()) byIndex.set(i + 1, job.id)
    shownJobs.set(s, { sessionId: s.id, byIndex })
    const columns = app.o?.term?.size?.().columns
    return {
      text: jobs.length
        ? jobs.map((j, i) => jobLine(j, i + 1, locale, columns)).join('\n')
        : tt('jobs.none', locale),
    }
  }
  const explicit = jobs.find((j) => j.id === key)
  let target = explicit
  if (!target && /^\d+$/.test(key)) {
    const n = Number(key)
    const snapshot = shownJobs.get(s)
    if (!snapshot || snapshot.sessionId !== s.id) {
      return { text: staleIndexMessage(locale, n) }
    }
    const cachedId = snapshot.byIndex.get(n)
    if (!cachedId) return { text: tt('jobs.unknown', locale, { key: oneLine(key) }) }
    target = jobs.find((j) => j.id === cachedId)
    if (!target) return { text: staleIndexMessage(locale, n, cachedId) }
  }
  if (!target) return { text: tt('jobs.unknown', locale, { key: oneLine(key) }) }
  const { output } = await s.jobsControl({ operation: 'kill', jobId: target.id })
  // The Web panel treats `ok: false` as a refusal too.
  if ((output as { ok?: unknown }).ok === false)
    return { text: tt('jobs.refused', locale, { id: oneLine(target.id) }) }
  return { text: tt('jobs.stopped', locale, { id: oneLine(target.id) }) }
}

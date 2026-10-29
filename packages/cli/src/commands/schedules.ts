import { resolve } from 'node:path'
import type { SchedulesUpsertParams, ScheduleTarget, ScheduleView } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
type Selector = SchedulesUpsertParams['selector']
type Refused = { updated: false; code: string }

const SELECTOR_FLAGS = ['every', 'cron', 'at', 'daily', 'weekly'] as const
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

const iso = (ms: number): string => new Date(ms).toISOString()
const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** `30m`, `2h`, `90s`, `1d`: the same period the Web form takes, bounded by the schedule service (60 s to 366 d). */
function everySeconds(text: string): number {
  const m = /^(\d+)([smhd])$/.exec(text)
  const seconds = m ? Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS] : Number.NaN
  if (!(seconds >= 60 && seconds <= 31622400))
    throw new UsageError('--every expects a period such as 90s, 30m, 2h or 1d, from 60s to 366d')
  return seconds
}

function weekdays(text: string): number[] {
  const days = text.split(',').map((d) => {
    const named = DAYS.indexOf(d.trim().toLowerCase().slice(0, 3))
    return named >= 0 && d.trim().length >= 3 ? named : Number(d)
  })
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 7))
    throw new UsageError('--weekly expects days (mon,wed or 0-7) and a time: --weekly mon,wed@09:00')
  return [...new Set(days)].sort()
}

/** Exactly one selector flag; each maps to a form the schema supports and the Web editor offers. */
function selectorOf(p: ParsedArgs): Selector | undefined {
  const given = SELECTOR_FLAGS.filter((f) => p[f] !== undefined)
  if (given.length === 0) {
    if (p.tz !== undefined) throw new UsageError('--tz needs --cron, --daily or --weekly')
    return undefined
  }
  if (given.length > 1) throw new UsageError('give only one of --every, --cron, --at, --daily, --weekly')
  if (p.tz !== undefined && (p.every !== undefined || p.at !== undefined))
    throw new UsageError('--tz needs --cron, --daily or --weekly')
  const timeZone = p.tz ?? localZone()
  if (p.every !== undefined) return { every_seconds: everySeconds(p.every) }
  if (p.at !== undefined) {
    const when = Date.parse(p.at)
    if (Number.isNaN(when)) throw new UsageError('--at expects an ISO time such as 2026-11-01T09:00:00Z')
    return { at: iso(when) }
  }
  if (p.cron !== undefined) return { cron: { expr: p.cron.trim(), timeZone } }
  if (p.daily !== undefined) {
    if (!HHMM.test(p.daily)) throw new UsageError('--daily expects HH:MM')
    return { daily: { time: p.daily, timeZone } }
  }
  const [days, time] = (p.weekly ?? '').split('@')
  if (!days || !time || !HHMM.test(time))
    throw new UsageError('--weekly expects days (mon,wed or 0-7) and a time: --weekly mon,wed@09:00')
  return { weekly: { time, timeZone, weekdays: weekdays(days) } }
}

function targetOf(p: ParsedArgs, before?: ScheduleTarget): ScheduleTarget | undefined {
  if (p.key !== undefined && (p.newSession || p.cwd !== undefined))
    throw new UsageError('--session cannot be combined with --new-session or --cwd')
  const dir = p.cwd === undefined ? undefined : resolve(p.cwd)
  const unattendedApproval = p.unattended ?? before?.unattendedApproval
  const unattended = unattendedApproval ? { unattendedApproval } : {}
  if (p.key !== undefined) return { kind: 'session', sessionKey: p.key, ...unattended }
  if (p.newSession)
    return {
      kind: 'new-session',
      cwd: dir ?? (before?.kind === 'new-session' ? before.cwd : process.cwd()),
      ...unattended,
    }
  if (!before) return { kind: 'new-session', cwd: dir ?? process.cwd(), ...unattended }
  if (p.cwd !== undefined && before.kind === 'session')
    throw new UsageError('--cwd needs --new-session on a task that runs in an existing session')
  if (p.cwd === undefined && p.unattended === undefined) return undefined
  return { ...before, ...(dir !== undefined ? { cwd: dir } : {}), ...unattended } as ScheduleTarget
}

function describe(selector: Selector): string {
  const [kind, value] = Object.entries(selector)[0] as [string, unknown]
  if (value && typeof value === 'object') {
    const f = value as { expr?: string; time?: string; weekdays?: number[]; timeZone?: string }
    const body = kind === 'cron' ? f.expr : kind === 'weekly' ? `${f.weekdays?.join(',')}@${f.time}` : f.time
    return `${kind} ${body}${f.timeZone ? ` ${f.timeZone}` : ''}`
  }
  return `${kind} ${value}`
}

const next = (v: ScheduleView): string => (v.nextRunAt === null ? '-' : iso(v.nextRunAt))

function row(v: ScheduleView): string {
  const last = v.runs.at(-1)
  return [
    v.id,
    v.status,
    oneLine(describe(v.selector)),
    next(v),
    last ? last.outcome : '-',
    oneLine(v.title),
  ].join('\t')
}

function detail(v: ScheduleView): string {
  const target =
    v.target.kind === 'session' ? `session ${v.target.sessionKey}` : `new session in ${v.target.cwd}`
  const lines = [
    ['id', v.id],
    ['title', oneLine(v.title)],
    ['status', v.status],
    ['when', oneLine(describe(v.selector))],
    ['next', next(v)],
    ['target', oneLine(target)],
    ['unattended', v.target.unattendedApproval ?? 'default'],
    ['revision', String(v.revision)],
    ['prompt', oneLine(v.prompt)],
  ].map(([k, val]) => `${(k as string).padEnd(11)}${val}`)
  const runs = v.runs.map(
    (r) =>
      `  ${iso(r.at)}\t${r.outcome}${r.reason ? `\t${oneLine(r.reason)}` : ''}${r.detail ? `\t${oneLine(r.detail)}` : ''}${r.sessionKey ? `\t${oneLine(r.sessionKey)}` : ''}`,
  )
  return [...lines, runs.length ? 'runs' : 'no runs yet', ...runs].join('\n')
}

/**
 * `agh schedules`: list, show, add, edit, pause, resume, run and archive scheduled tasks. All four RPCs
 * are admin tier; the daemon's refusal is shown as it comes and exits 1. Every selector the CLI sends
 * is one the schema supports and the Web editor offers.
 */
export async function schedulesCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [action, id, ...extra] = p.positional
  const out = (value: unknown, text: string) => io.stdout.write(p.json ? `${JSON.stringify(value)}\n` : text)
  const list = (params: { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }) =>
    client.call<{ schedules: ScheduleView[] }>('_agnes/v1/schedules.list', params)
  const refuse = (result: Refused): number => {
    if (p.json) io.stdout.write(`${JSON.stringify(result)}\n`)
    else io.stderr.write(`refused: ${oneLine(result.code)}\n`)
    return ExitCode.ERROR
  }
  const find = async (key: string): Promise<ScheduleView | undefined> =>
    (await list({ scope: 'all', includeArchived: true })).schedules.find((s) => s.id === key)

  if (action === undefined || action === 'list') {
    if (id !== undefined) throw new UsageError('schedules list takes no positional arguments')
    if (p.all && p.key !== undefined) throw new UsageError('--all and --session are exclusive')
    const result = await list({
      scope: p.key !== undefined ? 'session' : 'all',
      ...(p.key !== undefined ? { sessionKey: p.key } : {}),
      ...(p.archived ? { includeArchived: true } : {}),
    })
    out(result, result.schedules.length ? `${result.schedules.map(row).join('\n')}\n` : 'no schedules\n')
    return ExitCode.OK
  }
  if (action === 'show') {
    if (!id || extra.length) throw new UsageError('schedules show expects <id>')
    const found = await find(id)
    if (!found) {
      io.stderr.write(`no schedule ${oneLine(id)}\n`)
      return ExitCode.ERROR
    }
    out(found, `${detail(found)}\n`)
    return ExitCode.OK
  }
  if (action === 'add' || action === 'edit') {
    if (action === 'add' ? id !== undefined : !id || extra.length)
      throw new UsageError(
        action === 'add' ? 'schedules add takes flags only' : 'schedules edit expects <id>',
      )
    const before = action === 'edit' ? await find(id as string) : undefined
    if (action === 'edit' && !before) {
      io.stderr.write(`no schedule ${oneLine(id as string)}\n`)
      return ExitCode.ERROR
    }
    const selector = selectorOf(p) ?? before?.selector
    const prompt = p.prompt ?? before?.prompt
    if (!selector || !prompt)
      throw new UsageError(
        'schedules add expects --prompt and one of --every, --cron, --at, --daily, --weekly',
      )
    const target = targetOf(p, before?.target) ?? before?.target
    if (!target) throw new UsageError('schedules add needs a target')
    const title = p.title ?? before?.title ?? (prompt.split('\n')[0] as string).trim().slice(0, 120)
    const result = await client.call<ScheduleView | Refused>('_agnes/v1/schedules.upsert', {
      ...(before ? { id: before.id } : {}),
      title,
      prompt,
      selector,
      target,
    })
    if ('updated' in result) return refuse(result)
    out(result, `${row(result)}\n`)
    return ExitCode.OK
  }
  if (action === 'pause' || action === 'resume' || action === 'run') {
    if (!id || extra.length) throw new UsageError(`schedules ${action} expects <id>`)
    const result = await client.call<ScheduleView | Refused>('_agnes/v1/schedules.control', { id, action })
    if ('updated' in result) return refuse(result)
    out(result, `${row(result)}\n`)
    return ExitCode.OK
  }
  if (action === 'archive') {
    if (!id || extra.length) throw new UsageError('schedules archive expects <id>')
    const result = await client.call<{ deleted: boolean }>('_agnes/v1/schedules.archive', { id })
    out(result, result.deleted ? `archived ${oneLine(id)}\n` : '')
    if (result.deleted) return ExitCode.OK
    if (!p.json) io.stderr.write(`no schedule ${oneLine(id)} to archive\n`)
    return ExitCode.ERROR
  }
  throw new UsageError('schedules expects list, show, add, edit, pause, resume, run or archive')
}

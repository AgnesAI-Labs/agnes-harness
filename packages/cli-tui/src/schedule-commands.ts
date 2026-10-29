import type { SchedulesUpsertParams, ScheduleView } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

type Selector = SchedulesUpsertParams['selector']
type Refused = { updated: false; code: string }
type Pending = { params: SchedulesUpsertParams; when: string; confirmation?: Promise<SlashResult> }

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const MAX_PROMPT = 16_000
const SHOWN_PROMPT = 200

// One confirmation per session object: a session switch leaves the old one's card behind.
const pending = new WeakMap<Session, Pending>()

/** `30m`, `2h`, `90s`, `1d`, as `agh schedules add --every` takes them: 60 seconds to 366 days. */
export function everySeconds(text: string): number | undefined {
  const m = /^(\d+)([smhd])$/.exec(text)
  const seconds = m ? Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS] : Number.NaN
  return seconds >= 60 && seconds <= 31622400 ? seconds : undefined
}

function describe(selector: Selector): string {
  if ('every_seconds' in selector) {
    const s = selector.every_seconds
    const unit = s % 86400 === 0 ? 'd' : s % 3600 === 0 ? 'h' : s % 60 === 0 ? 'm' : 's'
    return `every ${s / UNIT_SECONDS[unit]}${unit}`
  }
  if ('daily' in selector) return `daily ${selector.daily.time} ${selector.daily.timeZone}`
  const [kind, value] = Object.entries(selector)[0] as [string, unknown]
  return `${kind} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
}

const shorten = (text: string): string => {
  const one = oneLine(text)
  return one.length > SHOWN_PROMPT ? `${one.slice(0, SHOWN_PROMPT - 1)}…` : one
}

function row(v: ScheduleView, n: number): string {
  const next = v.nextRunAt === null ? '-' : new Date(v.nextRunAt).toISOString()
  return `${n}. ${v.id}  ${v.status}  ${oneLine(describe(v.selector))}  next ${next}  ${shorten(v.title)}`
}

/** Builds the card for a new task that runs `prompt` in this very session, and waits for confirm. */
async function propose(app: TuiApp, selector: Selector, prompt: string, usage: string): Promise<SlashResult> {
  const { locale, session: s } = app
  if (!prompt.trim()) return { text: usage }
  if (prompt.length > MAX_PROMPT) return { text: tt('schedule.tooLong', locale, { max: MAX_PROMPT }) }
  // The schedule service names a session by its key; the open session's key comes from its runtime descriptor.
  const { sessionKey } = await s.client.session.runtime(s.id)
  const when = describe(selector)
  pending.set(s, {
    when,
    params: {
      title: [...((prompt.split('\n')[0] as string).trim() || prompt.trim())].slice(0, 120).join(''),
      prompt,
      selector,
      target: { kind: 'session', sessionKey },
    },
  })
  return {
    text: tt('schedule.card', locale, { when, prompt: shorten(prompt), session: oneLine(s.id) }),
    presentation: 'transcript',
  }
}

const usageOf = (app: TuiApp, cmd: string): string =>
  tt(cmd === '/loop' ? 'schedule.loopUsage' : 'schedule.usage', app.locale)

/**
 * `/schedule` and `/loop`: timed prompts for this session, through the same schedule RPCs as
 * `agh schedules add --session`. Creating shows a card (interval, prompt, session) first and only
 * `confirm` sends it; listing and deleting need no card. The daemon decides who may touch a task.
 */
export async function scheduleSlash(
  app: TuiApp,
  cmd: '/schedule' | '/loop',
  line: string,
): Promise<SlashResult> {
  const { locale, session: s } = app
  const body = line.trim().slice(cmd.length).trim()
  const [word = '', ...rest] = body.split(/\s+/)
  const usage = usageOf(app, cmd)
  const call = <T>(method: string, params: unknown) => s.client.call<T>(method, params)

  if (word === 'cancel') {
    pending.delete(s)
    return { text: tt('schedule.cancelled', locale) }
  }
  if (word === 'confirm') {
    const next = pending.get(s)
    if (!next) return { text: tt('schedule.noPending', locale) }
    // Repeated confirmations share one request, including its failure: a lost response does not
    // prove creation failed. Only a new proposal may start another creation request.
    next.confirmation ??= Promise.resolve().then(async () => {
      const result = await call<ScheduleView | Refused>('_agnes/v1/schedules.upsert', next.params)
      if (pending.get(s) === next) pending.delete(s)
      if ('updated' in result) return { text: tt('schedule.refused', locale, { code: oneLine(result.code) }) }
      return { text: tt('schedule.created', locale, { id: oneLine(result.id), when: next.when }) }
    })
    return next.confirmation
  }
  if (cmd === '/loop') {
    const seconds = word ? everySeconds(word) : undefined
    if (!word) return { text: usage }
    if (seconds === undefined) return { text: tt('schedule.badInterval', locale, { value: oneLine(word) }) }
    return propose(app, { every_seconds: seconds }, body.slice(word.length).trim(), usage)
  }
  if (word === 'every') {
    const seconds = everySeconds(rest[0] ?? '')
    if (seconds === undefined)
      return { text: tt('schedule.badInterval', locale, { value: oneLine(rest[0] ?? '') }) }
    return propose(app, { every_seconds: seconds }, body.replace(/^every\s+\S+\s*/, ''), usage)
  }
  if (word === 'daily') {
    if (!HHMM.test(rest[0] ?? '')) return { text: usage }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    return propose(
      app,
      { daily: { time: rest[0] as string, timeZone } },
      body.replace(/^daily\s+\S+\s*/, ''),
      usage,
    )
  }
  if (word !== '' && word !== 'list' && word !== 'delete') return { text: usage }
  const { sessionKey } = await s.client.session.runtime(s.id)
  const { schedules } = await call<{ schedules: ScheduleView[] }>('_agnes/v1/schedules.list', {
    scope: 'session',
    sessionKey,
  })
  if (word !== 'delete') {
    return {
      text: schedules.length
        ? schedules.map((v, i) => row(v, i + 1)).join('\n')
        : tt('schedule.none', locale),
      presentation: 'transcript',
    }
  }
  const key = rest[0] ?? ''
  const n = /^\d+$/.test(key) ? Number(key) : 0
  const target = schedules.find((v) => v.id === key) ?? (n >= 1 ? schedules[n - 1] : undefined)
  if (!target) return { text: tt('schedule.unknown', locale, { key: oneLine(key) }) }
  const { deleted } = await call<{ deleted: boolean }>('_agnes/v1/schedules.archive', { id: target.id })
  return {
    text: tt(deleted ? 'schedule.deleted' : 'schedule.unknown', locale, {
      id: oneLine(target.id),
      key: oneLine(key),
    }),
  }
}

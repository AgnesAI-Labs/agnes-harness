import type { DecisionSnapshot, JsonValue } from '@agnes/protocol'
import { triggersRequest } from '@agnes/web-admin/settings/triggers-api'
import type { HostAgnesClient } from '@agnes/web-client'

export type WaitingRun = {
  sessionId: string
  title: string
  source: 'schedule' | 'trigger'
  waiting: boolean
}

/** Read backend-owned automation history; the link opens the ordinary session approval surface. */
export async function waitingAutomation(client: HostAgnesClient): Promise<WaitingRun[] | undefined> {
  const [scheduled, triggered] = await Promise.allSettled([
    client.call<{ schedules?: { title: string; runs: { outcome: string; sessionKey?: string }[] }[] }>(
      '_agnes/v1/schedules.list',
      { scope: 'all', includeArchived: true },
    ),
    // Browser RPC carries session/read authority; administration stays on its existing BFF.
    triggersRequest({ action: 'list' }),
  ])
  if (scheduled.status === 'rejected' && triggered.status === 'rejected') return undefined
  const entries = new Map<string, WaitingRun>()
  if (scheduled.status === 'fulfilled')
    for (const task of scheduled.value.schedules ?? [])
      for (const run of task.runs ?? [])
        if (run.sessionKey && ['waiting_approval', 'needs_attention'].includes(run.outcome))
          entries.set(run.sessionKey, {
            sessionId: run.sessionKey,
            title: task.title,
            source: 'schedule',
            waiting: run.outcome === 'waiting_approval',
          })
  if (triggered.status === 'fulfilled')
    for (const run of triggered.value.snapshot?.deliveries ?? [])
      if (run.sessionId && ['waiting_approval', 'needs_attention'].includes(run.status))
        entries.set(run.sessionId, {
          sessionId: run.sessionId,
          title: triggered.value.snapshot?.rules.find((rule) => rule.id === run.ruleId)?.event ?? '',
          source: 'trigger',
          waiting: run.status === 'waiting_approval',
        })
  return [...entries.values()]
}

const record = (value: JsonValue | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const localized = (value: JsonValue | undefined, language: string) => {
  const entry = typeof value === 'string' ? value : (record(value)?.[language] ?? record(value)?.en)
  return typeof entry === 'string' && entry.trim() ? entry : undefined
}

/** Profile services bind their reviewed presentation into the subject, separately from response values. */
export function profileOperation(snapshot: DecisionSnapshot, language: string): string | undefined {
  return localized(record(record(snapshot.request.spec.subject)?.presentation)?.title, language)
}

/** Business object references are readable context; technical owner/service/decision IDs stay in details. */
export function profileSubject(snapshot: DecisionSnapshot, language: string): string | undefined {
  const zh = language === 'zh-CN'
  const subject = record(snapshot.request.spec.subject)
  const prepared = record(subject?.presentation)
  const input = record(prepared?.input) ?? record(subject?.input) ?? subject
  const name = input?.label ?? input?.name ?? input?.title ?? input?.ruleId ?? input?.id
  const revision =
    input?.expectedRevision ?? prepared?.revision ?? subject?.resourceRevision ?? input?.revision
  const parts: string[] = []
  if (typeof name === 'string' || typeof name === 'number') {
    const kind = input?.kind === 'rule' || input?.ruleId ? (zh ? '规则' : 'Rule') : zh ? '对象' : 'Object'
    parts.push(`${kind} ${name}`)
  }
  if (typeof revision === 'string' || typeof revision === 'number')
    parts.push(`${zh ? '修订' : 'Revision'} ${revision}`)
  return parts.length ? parts.join(' · ') : undefined
}

export function profileExpiry(expiresAt: string | null | undefined, language: string): string {
  const zh = language === 'zh-CN'
  if (!expiresAt) return zh ? '未设置到期时间' : 'No expiry'
  const at = new Date(expiresAt)
  if (!Number.isFinite(at.getTime())) return zh ? '到期时间不可用' : 'Expiry unavailable'
  return `${zh ? '到期时间' : 'Expires'} · ${new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(at)}`
}

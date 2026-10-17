import type { DecisionSnapshot } from '@agnes/protocol'
import type { HostAgnesClient, LocaleService } from '@agnes/web-client'
import { Button, Icon, Tooltip } from '@agnes/web-ui'
import { Approval } from '@agnes/web-units/shell'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

type WaitingRun = { sessionId: string; title: string }

/** Read backend-owned automation history; the link opens the ordinary session approval surface. */
async function waitingAutomation(client: HostAgnesClient): Promise<WaitingRun[] | undefined> {
  const [scheduled, triggered] = await Promise.allSettled([
    client.call<{ schedules?: { title: string; runs: { outcome: string; sessionKey?: string }[] }[] }>(
      '_agnes/v1/schedules.list',
      { scope: 'all', includeArchived: true },
    ),
    client.call<import('@agnes/protocol/gen/app-server').WebhookResult>('_agnes/v1/admin.triggers', {
      action: 'list',
    }),
  ])
  if (scheduled.status === 'rejected' && triggered.status === 'rejected') return undefined
  const entries = new Map<string, WaitingRun>()
  if (scheduled.status === 'fulfilled')
    for (const task of scheduled.value.schedules ?? [])
      for (const run of task.runs ?? [])
        if (run.sessionKey && ['waiting_approval', 'needs_attention'].includes(run.outcome))
          entries.set(run.sessionKey, { sessionId: run.sessionKey, title: task.title })
  if (triggered.status === 'fulfilled')
    for (const run of triggered.value.snapshot?.deliveries ?? [])
      if (run.sessionId && ['waiting_approval', 'needs_attention'].includes(run.status))
        entries.set(run.sessionId, { sessionId: run.sessionId, title: run.ruleId ?? '' })
  return [...entries.values()]
}

/** Profile approvals belong to the host shell and remain accessible without a selected session. */
export function ProfileApprovals({ client, locale }: { client: HostAgnesClient; locale: LocaleService }) {
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const zh = language === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [decisions, setDecisions] = useState<DecisionSnapshot[]>([])
  const [automation, setAutomation] = useState<WaitingRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const refresh = useRef<() => Promise<void>>(async () => {})
  const opened = useRef(open)
  opened.current = open
  useEffect(() => {
    let alive = true
    let pending: Promise<void> | undefined
    let again = false
    const read = () => {
      if (!alive || document.visibilityState === 'hidden') return Promise.resolve()
      if (pending) return pending
      pending = Promise.resolve().then(async () => {
        try {
          const [profile, runs] = await Promise.allSettled([
            client.call<{ decisions: DecisionSnapshot[] }>('_agnes/v1/profile.decisions.list', {}),
            waitingAutomation(client),
          ])
          if (alive) {
            if (profile.status === 'fulfilled') setDecisions(profile.value.decisions)
            if (runs.status === 'fulfilled' && runs.value !== undefined) setAutomation(runs.value)
            setReadFailed(
              profile.status === 'rejected' &&
                (runs.status === 'rejected' || runs.value === undefined) &&
                opened.current,
            )
          }
        } catch {
          if (alive && opened.current) setReadFailed(true)
        } finally {
          pending = undefined
          if (alive && again) {
            again = false
            void read()
          }
        }
      })
      return pending
    }
    const wake = () => {
      again = pending !== undefined
      void read()
    }
    const stopNotice = client.on?.('notice', (payload) => {
      const notice = payload as { kind?: unknown }
      // The daemon routes this signal to the authorized profile/principal, never as list data.
      if (notice?.kind === 'decisions_changed' || notice?.kind === 'automation_attention') wake()
    })
    let connectionState = client.connectionState
    const stopConnection = client.on?.('connectionStateChanged', (state) => {
      const previous = connectionState
      connectionState = state as typeof connectionState
      if (state === 'connected' && previous !== 'connected') wake()
    })
    refresh.current = read
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    void read()
    return () => {
      alive = false
      stopNotice?.()
      stopConnection?.()
      refresh.current = async () => {}
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
    }
  }, [client])
  const answer = async (snapshot: DecisionSnapshot, option: string) => {
    setBusy(true)
    setError(false)
    try {
      await client.call('_agnes/v1/profile.decisions.answer', {
        handle: snapshot.handle,
        revision: snapshot.revision,
        commandId: crypto.randomUUID(),
        response: { option, value: null },
      })
      setDecisions((values) => values.filter((value) => value.handle.id !== snapshot.handle.id))
      await refresh.current()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  const count = decisions.length + automation.length
  if (!count) return null
  const label = `${zh ? '操作审批' : 'Approvals'} (${count})`
  return (
    <>
      <Tooltip title={label}>
        <Button
          appearance="ghost"
          className="home-entry"
          onClick={() => {
            setOpen((value) => !value)
            void refresh.current()
          }}
          aria-expanded={open}
          aria-controls="profile-approvals"
          aria-label={label}
        >
          <Icon name="shield-check" />
          <span className="home-entry-label">{zh ? '操作审批' : 'Approvals'}</span>
          <span className="home-entry-badge" aria-hidden="true">
            {count}
          </span>
        </Button>
      </Tooltip>
      <section id="profile-approvals" hidden={!open} aria-label={zh ? '操作审批' : 'Approvals'}>
        <p>
          {zh
            ? '批准后返回原操作继续；审批只适用于所示操作。'
            : 'After approving, return to the original operation to continue. Approval applies only to the operation shown.'}
        </p>
        {(error || readFailed) && (
          <p role="alert">
            {zh ? '审批不可用，请刷新重试。' : 'Approval unavailable. Refresh and try again.'}
          </p>
        )}
        {automation.length > 0 && (
          <ul data-testid="automation-approval-inbox">
            {automation.map((run) => (
              <li key={run.sessionId}>
                <a href={`/?session=${encodeURIComponent(run.sessionId)}`}>
                  {run.title || (zh ? '自动化运行' : 'Automation run')} ·{' '}
                  {zh ? '需要处理：打开会话审批' : 'Needs attention: open session approval'}
                </a>
              </li>
            ))}
          </ul>
        )}
        {decisions.map((snapshot) => (
          <Approval
            key={`${snapshot.handle.id}:${snapshot.revision}:${busy}`}
            initialView={{
              key: snapshot.handle.id,
              title: snapshot.request.owner,
              summary: snapshot.request.spec.prompt,
              impact: zh ? '仅授权本次操作' : 'Authorize this operation once',
              risk: 'always',
              preview: JSON.stringify(snapshot.request.spec.subject, null, 2),
              disabled: busy,
              actions: snapshot.request.spec.options
                .filter((option) => ['allowed-once', 'rejected'].includes(option))
                .map((option) => ({
                  id: option,
                  label:
                    option === 'allowed-once' ? (zh ? '允许一次' : 'Allow once') : zh ? '拒绝' : 'Reject',
                  onSelect: () => {
                    void answer(snapshot, option)
                  },
                })),
            }}
          />
        ))}
      </section>
    </>
  )
}

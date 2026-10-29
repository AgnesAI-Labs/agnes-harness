import { type DecisionSnapshot, type PackageListResult, resolvePluginMetadata } from '@agnes/protocol'
import type { HostAgnesClient, LocaleService } from '@agnes/web-client'
import { Button, Dialog, decisionPresentation, getOverlayContainer, Icon, Tooltip } from '@agnes/web-ui'
import { Approval, type ApprovalHandle, type ApprovalView } from '@agnes/web-units/shell'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { onBroadcast } from '../app/global-events.js'
import { homeAdmin } from '../pages/admin-api.js'
import {
  profileExpiry,
  profileOperation,
  profileSubject,
  type WaitingRun,
  waitingAutomation,
} from './profile-attention.js'
import { createProfileAttention, type ProfileAttention } from './profile-attention-state.js'

/** Update the shared unit through its handle so disabling preserves the card and retry focus. */
function ProfileApproval({
  view,
  snapshot,
  language,
}: {
  view: ApprovalView
  snapshot: DecisionSnapshot
  language: string
}) {
  const approval = useRef<ApprovalHandle>(null)
  useLayoutEffect(() => approval.current?.render(view), [view])
  return (
    <Approval
      ref={approval}
      initialView={view}
      contentId={`profile-approval-${view.key}`}
      detail={
        <>
          {profileSubject(snapshot, language) && <p>{profileSubject(snapshot, language)}</p>}
          <p className="profile-decision-expiry">
            <time dateTime={snapshot.request.expiresAt ?? undefined}>
              {profileExpiry(snapshot.request.expiresAt, language)}
            </time>
          </p>
        </>
      }
    />
  )
}

/** A compact navigation entry; all approval content belongs to the host overlay. */
export function ProfileAttentionEntry({
  attention,
  locale,
}: {
  attention: ProfileAttention
  locale: LocaleService
}) {
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const view = useSyncExternalStore(attention.subscribe, attention.getSnapshot)
  if (!view.count) return null
  const title = language === 'zh-CN' ? '待处理' : 'Needs attention'
  const label = `${title} (${view.count})`
  return (
    <Tooltip title={label}>
      <Button
        appearance="ghost"
        className="home-entry"
        aria-label={label}
        aria-expanded={view.mode === 'inbox'}
        aria-controls="profile-approvals"
        onClick={() => (view.mode === 'inbox' ? attention.close() : attention.openInbox())}
      >
        <Icon name="shield-check" />
        <span className="home-entry-label">{title}</span>
        <span className="home-entry-badge" aria-hidden="true">
          {view.count}
        </span>
      </Button>
    </Tooltip>
  )
}

/** Profile approvals belong to the host shell and remain accessible without a selected session. */
export function ProfileApprovals({
  client,
  locale,
  attention: supplied,
  entry = true,
}: {
  client: HostAgnesClient
  locale: LocaleService
  attention?: ProfileAttention
  entry?: boolean
}) {
  const [owned] = useState(createProfileAttention)
  const attention = supplied ?? owned
  const view = useSyncExternalStore(attention.subscribe, attention.getSnapshot)
  const open = !!view.mode
  useEffect(() => () => owned.dispose(), [owned])
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const zh = language === 'zh-CN'
  const [decisions, setDecisions] = useState<DecisionSnapshot[]>([])
  const [packages, setPackages] = useState<PackageListResult['packages']>([])
  const [automation, setAutomation] = useState<WaitingRun[]>([])
  const [busy, setBusy] = useState(false)
  const answering = useRef(false)
  const answerScope = useRef<AbortController>()
  const [error, setError] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const refresh = useRef<(afterWrite?: boolean) => Promise<void>>(async () => {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useLayoutEffect(() => {
    const scope = new AbortController()
    answerScope.current = scope
    answering.current = false
    setBusy(false)
    setError(false)
    return () => scope.abort()
  }, [client, open, view.decision?.id])
  const opened = useRef(open)
  opened.current = open
  useEffect(() => {
    setDecisions([])
    setAutomation([])
    setPackages([])
    setReadFailed(false)
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
            if (profile.status === 'fulfilled' && profile.value.decisions.length) {
              void homeAdmin()
                .then(({ api }) => api.list())
                .then(
                  (inventory) => {
                    if (alive) setPackages(inventory.packages)
                  },
                  () => undefined,
                )
            }
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
    const stopAutomation = onBroadcast('agnes:automation-invalidated', wake)
    let connectionState = client.connectionState
    const stopConnection = client.on?.('connectionStateChanged', (state) => {
      const previous = connectionState
      connectionState = state as typeof connectionState
      if (state === 'connected' && previous !== 'connected') wake()
    })
    refresh.current = async (afterWrite) => {
      if (afterWrite && pending) await pending
      return read()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    void read()
    return () => {
      alive = false
      stopNotice?.()
      stopAutomation()
      stopConnection?.()
      refresh.current = async () => {}
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
    }
  }, [client])
  const answer = async (snapshot: DecisionSnapshot, option: string) => {
    if (answering.current) return
    const scope = answerScope.current
    const reread = refresh.current
    const current = () => !!scope && scope === answerScope.current && !scope.signal.aborted
    answering.current = true
    setBusy(true)
    setError(false)
    try {
      await client.call('_agnes/v1/profile.decisions.answer', {
        handle: snapshot.handle,
        revision: snapshot.revision,
        commandId: crypto.randomUUID(),
        response: {
          option,
          value: decisionPresentation(snapshot.request.spec.presentation)?.responseValue ?? null,
        },
      })
      if (!current()) return
      setDecisions((values) => values.filter((value) => value.handle.id !== snapshot.handle.id))
      await reread(true)
      if (current() && attention.getSnapshot().mode === 'decision') attention.close()
    } catch {
      if (current()) setError(true)
    } finally {
      if (current()) {
        answering.current = false
        setBusy(false)
      }
    }
  }
  const count = decisions.filter((item) => item.handle.id !== view.decision?.id).length + automation.length
  useLayoutEffect(() => {
    attention.setCount(count)
    if (!count && view.mode === 'inbox') attention.close()
  }, [attention, count, view.mode])
  useEffect(() => {
    if (open || view.decision?.id) void refresh.current()
  }, [open, view.decision?.id])
  if (!count && !view.decision) return null
  const shown = view.decision ? decisions.filter((item) => item.handle.id === view.decision?.id) : decisions
  return (
    <>
      {entry && <ProfileAttentionEntry attention={attention} locale={locale} />}
      <Dialog
        key={view.decision?.id ?? 'inbox'}
        centered
        open={open}
        forceRender
        title={
          view.mode === 'decision'
            ? zh
              ? '确认操作'
              : 'Review operation'
            : zh
              ? '待处理'
              : 'Needs attention'
        }
        footer={null}
        onCancel={attention.close}
        getContainer={() => getOverlayContainer(view.anchor)}
        className="profile-attention-dialog"
      >
        <section
          className="profile-attention-panel"
          id="profile-approvals"
          hidden={!open}
          aria-label={zh ? '待处理' : 'Needs attention'}
        >
          {!view.decision && (
            <p>{zh ? '查看需要你确认或处理的事项。' : 'Review items that need your attention.'}</p>
          )}
          {(error || readFailed) && (
            <p role="alert">
              {zh ? '审批不可用，请刷新重试。' : 'Approval unavailable. Refresh and try again.'}
            </p>
          )}
          {!view.decision &&
            (['schedule', 'trigger'] as const).map((source) => {
              const runs = automation.filter((run) => run.source === source)
              if (!runs.length) return null
              const heading =
                source === 'schedule' ? (zh ? '定时任务' : 'Scheduled tasks') : zh ? '触发器' : 'Triggers'
              return (
                <section key={source} aria-label={heading} className="profile-attention-group">
                  <h3>{heading}</h3>
                  <ul data-testid="automation-approval-inbox">
                    {runs.map((run) => (
                      <li key={run.sessionId}>
                        <a href={`/?session=${encodeURIComponent(run.sessionId)}`}>
                          <strong>
                            {heading} · {run.title || (zh ? '自动化运行' : 'Automation run')} ·{' '}
                            {run.waiting
                              ? zh
                                ? '等待你确认'
                                : 'Waiting for your approval'
                              : zh
                                ? '需要处理'
                                : 'Needs attention'}
                          </strong>
                          <span>
                            {zh
                              ? '打开运行会话，查看详情并处理。'
                              : 'Open the run session to review and respond.'}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          {!view.decision && decisions.length > 0 && <h3>{zh ? '插件请求' : 'Plugin requests'}</h3>}
          {view.decision && !shown.length && (
            <p role="status">
              {zh
                ? '正在读取审批；若事项已处理，请关闭此窗口。'
                : 'Loading approval. Close this window if it has already been handled.'}
            </p>
          )}
          {shown.map((snapshot) => {
            const presentation = decisionPresentation(snapshot.request.spec.presentation)
            const metadata = packages.find((item) => item.id === snapshot.request.sourcePackage)?.metadata
            const name = resolvePluginMetadata(metadata, zh ? 'zh-CN' : 'en')?.displayName
            const operation = presentation?.title ?? profileOperation(snapshot, language)
            const title = operation
              ? `${zh ? '插件' : 'Plugin'}${name ? ` ${name}` : ''} · ${operation}`
              : zh
                ? `${name || '插件'} · 请求执行一个操作`
                : `${name || 'Plugin'} · requests an operation`
            return (
              <ProfileApproval
                key={snapshot.handle.id}
                snapshot={snapshot}
                language={language}
                view={{
                  key: snapshot.handle.id,
                  title,
                  summary: zh ? '仅对此次操作生效。' : 'Applies only to this operation.',
                  ...(presentation ? { presentation } : {}),
                  impact: '',
                  risk: 'always',
                  preview: JSON.stringify(
                    { handle: snapshot.handle, revision: snapshot.revision, request: snapshot.request },
                    null,
                    2,
                  ),
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
            )
          })}
        </section>
      </Dialog>
    </>
  )
}

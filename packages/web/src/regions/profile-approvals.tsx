import type { DecisionSnapshot } from '@agnes/protocol'
import type { HostAgnesClient, LocaleService } from '@agnes/web-client'
import { Button, Icon, Tooltip } from '@agnes/web-ui'
import { Approval } from '@agnes/web-units'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** Profile approvals belong to the host shell and remain accessible without a selected session. */
export function ProfileApprovals({ client, locale }: { client: HostAgnesClient; locale: LocaleService }) {
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const zh = language === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [decisions, setDecisions] = useState<DecisionSnapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
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
          const result = await client.call<{ decisions: DecisionSnapshot[] }>(
            '_agnes/v1/profile.decisions.list',
            {},
          )
          if (alive) {
            setDecisions(result.decisions)
            setError(false)
          }
        } catch {
          if (alive && opened.current) setError(true)
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
      if (notice?.kind === 'decisions_changed') wake()
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
  if (!decisions.length) return null
  const label = `${zh ? '全局操作审批' : 'Profile approvals'} (${decisions.length})`
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
            {decisions.length}
          </span>
        </Button>
      </Tooltip>
      <section id="profile-approvals" hidden={!open} aria-label={zh ? '全局操作审批' : 'Profile approvals'}>
        <p>
          {zh
            ? '批准后返回原操作继续；审批只适用于所示操作。'
            : 'After approving, return to the original operation to continue. Approval applies only to the operation shown.'}
        </p>
        {error && (
          <p role="alert">
            {zh ? '审批不可用，请刷新重试。' : 'Approval unavailable. Refresh and try again.'}
          </p>
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

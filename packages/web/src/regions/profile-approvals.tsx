import type { DecisionSnapshot } from '@agnes/protocol'
import type { HostAgnesClient, LocaleService } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'
import { Approval } from '@agnes/web-units'
import { useEffect, useState, useSyncExternalStore } from 'react'

/** Profile approvals belong to the host shell and remain accessible without a selected session. */
export function ProfileApprovals({ client, locale }: { client: HostAgnesClient; locale: LocaleService }) {
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const zh = language === 'zh-CN'
  const [open, setOpen] = useState(false)
  const [decisions, setDecisions] = useState<DecisionSnapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true,
      reading = false
    const read = async () => {
      if (reading) return
      reading = true
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
        if (alive && open) setError(true)
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [client, open])
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
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={zh ? '全局操作审批' : 'Profile approvals'}
      >
        {zh ? '操作审批' : 'Approvals'}
        {decisions.length ? ` (${decisions.length})` : ''}
      </Button>
      <section hidden={!open} aria-label={zh ? '全局操作审批' : 'Profile approvals'}>
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
        {!decisions.length && <p>{zh ? '没有待审批操作。' : 'No pending approvals.'}</p>}
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

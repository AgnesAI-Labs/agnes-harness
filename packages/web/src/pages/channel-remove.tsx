import type { ProfileServiceReceipt } from '@agnes/protocol'
import { Button, ConfirmDialog } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { channelsChanged } from './channel-model.js'
import type { ChannelGroup, ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

/** Removal is a reviewed configuration change; the backend owns the merge and cleanup. */
export function RemoveConnection({ data, group, row, zh, disabled, onPending }: {
  data: HomePageData; group: ChannelGroup; row: ManagedInstance; zh: boolean
  disabled: boolean; onPending(value: boolean): void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<Record<string, unknown>>()
  const operation = useRef<Record<string, unknown>>()
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const input = operation.current ?? {
      extension: group.provider.extension, instanceId: row.id,
      configurationRevision: group.configurationRevision,
      expectedVersion: row.version, operationId: crypto.randomUUID(),
    }
    operation.current = input
    setPending(input)
    onPending(true)
    setBusy(true)
    setMessage('')
    try {
      const { receipt } = await (data.channelCall ?? data.call)<{ receipt: ProfileServiceReceipt }>(
        'channels.remove', input,
      )
      if (!alive.current) return
      if (receipt.state === 'completed') {
        operation.current = undefined
        setPending(undefined)
        onPending(false)
        setOpen(false)
        channelsChanged()
      } else if (receipt.state === 'approval-required') {
        data.requestProfileApproval?.(receipt)
        setMessage(zh ? '请完成原生审批，再点击“继续删除”。' : 'Complete native approval, then Continue deletion.')
      } else if (receipt.state === 'refused' || receipt.state === 'cancelled') {
        operation.current = undefined
        setPending(undefined)
        onPending(false)
        setMessage(zh ? '删除未获批准，实例已保留。' : 'Deletion was not approved. The instance was kept.')
      } else {
        setMessage(zh ? '删除结果尚未确认，请继续核对同一次操作。' : 'Deletion is unconfirmed. Continue reconciling the same operation.')
      }
    } catch {
      if (alive.current) setMessage(zh
        ? '删除未确认，可继续核对同一次操作；配置或绑定发生变化时，请刷新页面后重新审阅。'
        : 'Deletion is unconfirmed. Retry the same operation; if configuration or bindings changed, refresh and review again.')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return <>
    <Button size="small" appearance="ghost" danger disabled={busy || (disabled && !pending)}
      onClick={() => setOpen(true)}>{pending ? (zh ? '继续删除' : 'Continue deletion') : (zh ? '删除实例' : 'Delete instance')}</Button>
    <ConfirmDialog open={open} title={zh ? '删除渠道实例' : 'Delete channel instance'} destructive busy={busy}
      confirmDisabled={disabled && !pending}
      confirmLabel={pending ? (zh ? '继续删除' : 'Continue deletion') : (zh ? '删除实例' : 'Delete instance')}
      cancelLabel={zh ? '取消' : 'Cancel'} onConfirm={() => void remove()} onCancel={() => setOpen(false)}>
      <p>{zh ? '将断开此机器人的连接，并删除该实例的配置、聊天目标和绑定。已有会话与保存的凭据会保留。'
        : 'Disconnect this bot and remove its instance configuration, chat targets and bindings. Existing sessions and saved credentials are kept.'}</p>
      <p><code>{row.id}</code></p>
      {message && <p role="status">{message}</p>}
    </ConfirmDialog>
  </>
}

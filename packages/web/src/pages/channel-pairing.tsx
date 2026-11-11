import type { ProfileServiceReceipt } from '@agnes/protocol'
import { Button, ConfirmDialog, Select } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { channelsChanged } from './channel-model.js'
import type { ChannelGroup, ChannelPairingTarget, ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

type Mint = { receipt: ProfileServiceReceipt; code?: string; expiresAt?: number }

/**
 * Pairs one direct chat of this bot with a plugin service. Minting a code needs a person's approval;
 * the code is shown once and is sent to the bot in a direct message from the chat to pair.
 */
export function ChannelPairings({
  data,
  group,
  row,
  zh,
  disabled,
}: {
  data: HomePageData
  group: ChannelGroup
  row: ManagedInstance
  zh: boolean
  disabled: boolean
}) {
  const call = data.channelCall ?? data.call
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [targets, setTargets] = useState<ChannelPairingTarget[]>()
  const [choice, setChoice] = useState<string>()
  const [code, setCode] = useState<{ code: string; expiresAt: number }>()
  const operation = useRef<Record<string, unknown>>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const keyOf = (target: { owner: string; service: string }) => `${target.owner}\n${target.service}`
  const start = async () => {
    setOpen(true)
    setMessage('')
    setCode(undefined)
    if (operation.current) return
    try {
      const { targets } = await call<{ targets: ChannelPairingTarget[] }>('channels.pairing', {
        action: 'targets',
      })
      if (!alive.current) return
      setTargets(targets)
      const free = targets.find((target) => !target.paired)
      setChoice(free && keyOf(free))
    } catch {
      if (alive.current) setMessage(zh ? '暂时无法读取插件服务。' : 'Plugin services cannot be read now.')
    }
  }
  const mint = async () => {
    const target = targets?.find((item) => keyOf(item) === choice)
    if (!operation.current && !target) return
    operation.current ??= {
      action: 'mint',
      extension: group.provider.extension,
      instanceId: row.id,
      target: { owner: target!.owner, service: target!.service },
      operationId: crypto.randomUUID(),
    }
    setBusy(true)
    setMessage('')
    try {
      const result = await call<Mint>('channels.pairing', operation.current)
      if (!alive.current) return
      if (result.receipt.state === 'approval-required') {
        data.requestProfileApproval?.(result.receipt)
        setMessage(zh ? '请完成原生审批，再点击“继续生成”。' : 'Complete native approval, then Continue.')
        return
      }
      operation.current = undefined
      if (result.code && result.expiresAt) setCode({ code: result.code, expiresAt: result.expiresAt })
      else
        setMessage(
          result.receipt.state === 'completed'
            ? zh
              ? '配对码只显示一次；如未记下，请重新生成。'
              : 'The code is shown only once. Create a new one if you missed it.'
            : zh
              ? '生成未获批准。'
              : 'Creating the code was not approved.',
        )
    } catch (error) {
      if (!alive.current) return
      const refusal = (error as { code?: string }).code
      if (refusal) operation.current = undefined
      setMessage(
        refusal === 'TARGET_PAIRED'
          ? zh
            ? '这个插件服务已与一个聊天配对，请先解除。'
            : 'This plugin service is already paired with a chat. Unpair it first.'
          : refusal === 'CHANNEL_UNAVAILABLE'
            ? zh
              ? '机器人尚未连接，连接后再生成。'
              : 'The bot is not connected. Create the code once it connects.'
            : zh
              ? '生成未确认，可重试同一次操作。'
              : 'Not confirmed. Retry the same operation.',
      )
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const revoke = async (pairingId: string) => {
    setBusy(true)
    setMessage('')
    try {
      await call('channels.pairing', { action: 'revoke', pairingId })
      channelsChanged()
    } catch {
      if (alive.current) setMessage(zh ? '解除未确认，请重试。' : 'Unpair unconfirmed. Retry.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div className="channel-pairings">
      {(row.pairings ?? []).map((pairing) => (
        <div className="channel-binding-detail" key={pairing.id}>
          <div>
            <strong>{pairing.target.packageId}</strong>
            <span>
              {pairing.label} ·{' '}
              {pairing.running
                ? zh
                  ? '私聊消息交给插件服务'
                  : 'Direct messages go to the plugin service'
                : zh
                  ? '插件服务未运行'
                  : 'Plugin service not running'}
            </span>
          </div>
          <Button appearance="ghost" size="small" disabled={busy} onClick={() => void revoke(pairing.id)}>
            {zh ? '解除配对' : 'Unpair'}
          </Button>
        </div>
      ))}
      <Button size="small" appearance="ghost" disabled={disabled || busy} onClick={() => void start()}>
        {operation.current
          ? zh
            ? '继续生成配对码'
            : 'Continue pairing code'
          : zh
            ? '配对到插件服务'
            : 'Pair with a plugin service'}
      </Button>
      <ConfirmDialog
        open={open}
        title={zh ? '配对到插件服务' : 'Pair with a plugin service'}
        busy={busy}
        confirmDisabled={!!code || (!operation.current && !choice)}
        confirmLabel={operation.current ? (zh ? '继续生成' : 'Continue') : zh ? '生成配对码' : 'Create code'}
        cancelLabel={code ? (zh ? '完成' : 'Done') : zh ? '取消' : 'Cancel'}
        onConfirm={() => void mint()}
        onCancel={() => {
          setOpen(false)
          setCode(undefined)
          if (code) channelsChanged()
        }}
      >
        <p>
          {zh
            ? '生成配对码需要你的审批。在一小时内从你的私聊发给这个机器人，之后这个私聊里你发的文字会交给所选插件服务，它也能通过这个机器人给你发文字。'
            : 'Creating a pairing code needs your approval. Send it to this bot from your direct chat within an hour; your text in that chat then goes to the chosen plugin service, which can send text back through this bot.'}
        </p>
        {targets && !operation.current && (
          <Select
            aria-label={zh ? '插件服务' : 'Plugin service'}
            value={choice}
            onChange={(value) => setChoice(String(value))}
            options={targets.map((target) => ({
              value: keyOf(target),
              label: `${target.label} · ${target.service}`,
              disabled: target.paired,
            }))}
            notFoundContent={zh ? '没有可配对的插件服务' : 'No plugin service can be paired'}
          />
        )}
        {code && (
          <p role="status">
            <code className="channel-pairing-code">{code.code}</code>{' '}
            {zh
              ? `只显示这一次，${new Date(code.expiresAt).toLocaleTimeString()} 前有效。`
              : `Shown only once. Valid until ${new Date(code.expiresAt).toLocaleTimeString()}.`}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </ConfirmDialog>
    </div>
  )
}

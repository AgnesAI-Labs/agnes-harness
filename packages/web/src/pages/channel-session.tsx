import { Button, Select, SettingsCheckbox } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChannelStatus, channelConnectionState } from './channel-presentation.js'
import type { Provider, SessionInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

export function SessionBindings({
  data,
  provider,
  sessionId,
  instanceIds,
  refreshKey,
  zh,
  onBound,
  onChanged,
}: {
  data: HomePageData
  provider: Provider
  sessionId: string
  instanceIds: readonly string[]
  refreshKey: string
  zh: boolean
  onBound?(value: boolean): void
  onChanged?(): void
}) {
  const callbacks = useRef({ onBound, onChanged })
  callbacks.current = { onBound, onChanged }
  const [instances, setInstances] = useState<SessionInstance[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [consent, setConsent] = useState(false)
  const current = useRef(true)
  const readVersion = useRef(0)
  const connectionVersion = useRef(refreshKey)
  const pending = useRef<{
    action: 'bind' | 'unbind'
    instanceId: string
    commandId: string
    input: { instanceId: string; expectedVersion: number; targetId?: string }
  }>()
  const refresh = useCallback(async () => {
    const version = ++readVersion.current
    try {
      const result = await (data.channelCall ?? data.call)<{ output: { instances: SessionInstance[] } }>(
        '_agnes/v1/extension.call',
        { sessionId, extension: provider.extension, service: 'channel.session', input: {} },
      )
      if (current.current && version === readVersion.current) {
        setInstances(result.output.instances.filter((row) => instanceIds.includes(row.id)))
        setError((previous) =>
          previous === (zh ? '无法读取绑定状态。' : 'Unable to read bindings.') ? '' : previous,
        )
        setLoaded(true)
        callbacks.current.onBound?.(
          result.output.instances.some(
            (row) =>
              instanceIds.includes(row.id) && row.bindings.some((binding) => binding.state === 'active'),
          ),
        )
      }
    } catch {
      if (current.current && version === readVersion.current) {
        setInstances([])
        setLoaded(false)
        callbacks.current.onBound?.(false)
        setError(zh ? '无法读取绑定状态。' : 'Unable to read bindings.')
      }
    }
  }, [data, provider.extension, sessionId, zh, instanceIds])
  useEffect(() => {
    current.current = true
    if (connectionVersion.current !== refreshKey && !pending.current) {
      setSelected({})
      setConsent(false)
    }
    connectionVersion.current = refreshKey
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 5000)
    return () => {
      current.current = false
      readVersion.current++
      clearInterval(timer)
    }
  }, [refresh, refreshKey])
  const change = async (row: SessionInstance, action: 'bind' | 'unbind') => {
    setBusy(true)
    setError('')
    if (pending.current?.action !== action || pending.current.instanceId !== row.id) {
      pending.current = {
        action,
        instanceId: row.id,
        commandId: crypto.randomUUID(),
        input: {
          instanceId: row.id,
          expectedVersion: row.version,
          ...(action === 'bind' ? { targetId: selected[row.id] ?? '' } : {}),
        },
      }
    }
    try {
      await (data.channelCall ?? data.call)('_agnes/v1/extension.call', {
        sessionId,
        extension: provider.extension,
        service: `channel.${action}`,
        commandId: pending.current.commandId,
        input: pending.current.input,
      })
      pending.current = undefined
      callbacks.current.onChanged?.()
    } catch {
      if (current.current)
        setError(
          zh
            ? '操作未确认。请刷新核对；待核对的绑定可以显式解绑。'
            : 'Operation unconfirmed. Refresh to reconcile; pending bindings can be explicitly unbound.',
        )
    } finally {
      if (current.current) {
        await refresh()
        setBusy(false)
      }
    }
  }
  return (
    <section className="channel-session" data-testid="channel-session-bindings">
      <div className="channel-section-heading">
        <div>
          <h3>{zh ? '当前会话绑定' : 'This session’s bindings'}</h3>
          <p>
            {zh ? '选择聊天目标，仅同步绑定后的新消息。' : 'Choose a chat. Only new messages are shared.'}
          </p>
        </div>
        <Button appearance="ghost" size="small" disabled={busy} onClick={() => void refresh()}>
          {zh ? '刷新绑定和目标' : 'Refresh bindings and targets'}
        </Button>
      </div>
      {loaded && !instances.length && (
        <p>
          {zh ? '当前工作区没有渠道实例，请先添加配置。' : 'Configure an instance for this workspace first.'}
        </p>
      )}
      {instances.map((row) => (
        <div key={row.id} className="channel-binding-row">
          <div className="channel-binding-identity">
            <strong>{row.id}</strong>
            <ChannelStatus state={channelConnectionState(row.connection)} zh={zh} />
          </div>
          {row.bindings.length ? (
            row.bindings.map((binding) => (
              <div key={binding.targetId} className="channel-binding-target">
                <span>
                  {binding.label} ·{' '}
                  {binding.state === 'active'
                    ? zh
                      ? '已绑定'
                      : 'Bound'
                    : binding.state === 'waiting'
                      ? zh
                        ? '等待机器人收到消息确认'
                        : 'Waiting for an inbound message'
                      : zh
                        ? '待核对，转发已暂停'
                        : 'Pending reconciliation; forwarding paused'}
                </span>
                <Button disabled={busy} onClick={() => void change(row, 'unbind')}>
                  {zh ? '解绑' : 'Unbind'}
                </Button>
              </div>
            ))
          ) : (
            <>
              <Select
                aria-label={zh ? '聊天目标' : 'Chat target'}
                placeholder={zh ? '选择已确认的聊天目标' : 'Choose a verified chat'}
                value={selected[row.id] ?? null}
                disabled={busy}
                options={row.targets.map((target) => ({
                  value: target.id,
                  label:
                    target.label +
                    (!target.confirmed
                      ? zh
                        ? ' · 等待机器人消息确认'
                        : ' · Waiting for an inbound message'
                      : target.unavailable
                        ? zh
                          ? ' · 已绑定其他会话'
                          : ' · Bound to another session'
                        : ''),
                  disabled: target.unavailable || !target.confirmed,
                }))}
                onChange={(id: string) => setSelected((s) => ({ ...s, [row.id]: id }))}
              />
              {!row.targets.length && (
                <p>
                  {zh
                    ? '请先向机器人发消息；群聊需 @机器人，再刷新目标列表。'
                    : 'Send the bot a message (mention it in groups), then refresh targets.'}
                </p>
              )}
              <Button
                appearance="primary"
                disabled={busy || !consent || !selected[row.id]}
                onClick={() => void change(row, 'bind')}
              >
                {zh ? '绑定当前会话' : 'Bind this session'}
              </Button>
            </>
          )}
        </div>
      ))}
      <SettingsCheckbox
        label={
          zh
            ? '我确认向所选聊天目标同步本会话后续的新消息。'
            : 'Share future messages from this session with the selected chat.'
        }
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
      />
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

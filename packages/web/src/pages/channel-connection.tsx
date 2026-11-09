import { Button, Disclosure, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { openChannelDialog } from './channel-dialog-state.js'
import { channelsChanged } from './channel-model.js'
import { ChannelStatus, channelConnectionState } from './channel-presentation.js'
import type { ChannelGroup, ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

export function ConnectionCard({
  data,
  group,
  row,
  hidden,
}: {
  data: HomePageData
  group: ChannelGroup
  row: ManagedInstance
  hidden?: boolean
}) {
  const zh = useDocumentLanguage() === 'zh-CN'
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const pending = useRef<{
    commandId: string
    sessionId: string
    input: { instanceId: string; expectedVersion: number }
  }>()
  useEffect(() => {
    if (
      pending.current &&
      !row.bindings.some((binding) => binding.sessionId === pending.current?.sessionId)
    ) {
      pending.current = undefined
      setMessage('')
    }
  }, [row.bindings])
  const unbind = async (sessionId: string) => {
    pending.current ??= {
      commandId: crypto.randomUUID(),
      sessionId,
      input: { instanceId: row.id, expectedVersion: row.version },
    }
    if (pending.current.sessionId !== sessionId) return
    setBusy(true)
    setMessage('')
    try {
      await (data.channelCall ?? data.call)('_agnes/v1/extension.call', {
        ...pending.current,
        extension: group.provider.extension,
        service: 'channel.unbind',
      })
      pending.current = undefined
      channelsChanged()
    } catch {
      setMessage(
        zh
          ? '解绑未确认，请重试以核对同一次操作。'
          : 'Unbind unconfirmed. Retry to reconcile the same operation.',
      )
    } finally {
      setBusy(false)
    }
  }
  const sessionId = row.bindings[0]?.sessionId ?? row.intendedSession?.sessionId
  const first = row.bindings[0]
  const title =
    first?.sessionTitle || row.intendedSession?.title || (zh ? '尚未绑定会话' : 'No session bound')
  return (
    <article className="channel-connection" data-instance-id={row.id} hidden={hidden}>
      <div className="channel-connection-summary">
        <div className="channel-connection-identity">
          <div className="channel-connection-title">
            {first ? (
              <a href={`?session=${encodeURIComponent(first.sessionId)}`} title={title}>
                {title}
              </a>
            ) : (
              <strong title={title}>{title}</strong>
            )}
            {row.bindings.length > 1 && (
              <span className="channel-count" title={zh ? '绑定会话数' : 'Bound sessions'}>
                +{row.bindings.length - 1}
              </span>
            )}
          </div>
          <div className="channel-connection-peer">
            {first ? (
              <>
                <span title={first.label}>{first.label}</span>
                <span className="channel-sharing" data-active={first.state === 'active'}>
                  {first.state === 'active'
                    ? zh
                      ? '同步中'
                      : 'Sharing'
                    : zh
                      ? '待确认'
                      : 'Needs confirmation'}
                </span>
              </>
            ) : (
              <>
                <span>{zh ? '待绑定聊天对象' : 'No chat bound'}</span>
                <code title={row.id}>{row.id}</code>
              </>
            )}
            {row.unavailable && <span>{zh ? '部分绑定不可访问' : 'Some bindings unavailable'}</span>}
          </div>
        </div>
        <ChannelStatus state={channelConnectionState(row.connection)} zh={zh} />
        <Button
          size="small"
          disabled={busy || !!pending.current || row.unavailable || !group.provider.bindingAvailable}
          onClick={() =>
            openChannelDialog({ extension: group.provider.extension, instanceId: row.id, sessionId })
          }
        >
          {zh ? '配置与绑定' : 'Manage connection'}
        </Button>
      </div>
      <Disclosure
        className="channel-connection-details"
        variant="plain"
        summary={zh ? '详情' : 'Details'}
        summaryProps={{
          'aria-label': `${zh ? '连接详情' : 'Connection details'}: ${title}`,
          title: zh ? '展开或收起连接详情' : 'Show or hide connection details',
        }}
      >
        <div className="channel-connection-expanded">
          <dl className="channel-connection-meta">
            <div>
              <dt>{zh ? '实例标识' : 'Instance'}</dt>
              <dd>
                <code>{row.id}</code>
              </dd>
            </div>
            <div>
              <dt>{zh ? '工作区' : 'Workspace'}</dt>
              <dd>{row.workspace}</dd>
            </div>
          </dl>
          {row.bindings.map((binding) => (
            <div className="channel-binding-detail" key={binding.targetId}>
              <div>
                <a href={`?session=${encodeURIComponent(binding.sessionId)}`}>{binding.sessionTitle}</a>
                <span>
                  {binding.label} ·{' '}
                  {binding.state === 'active'
                    ? zh
                      ? '同步中'
                      : 'Sharing new messages'
                    : zh
                      ? '等待确认，尚未同步'
                      : 'Waiting for confirmation'}
                </span>
              </div>
              <Button
                appearance="ghost"
                size="small"
                disabled={busy || row.unavailable}
                onClick={() => void unbind(binding.sessionId)}
              >
                {zh ? '解绑' : 'Unbind'}
              </Button>
            </div>
          ))}
          <div className="channel-card-actions">
            <Button
              size="small"
              appearance="ghost"
              disabled={busy || !!pending.current || row.unavailable || !group.provider.bindingAvailable}
              onClick={() =>
                openChannelDialog({ extension: group.provider.extension, instanceId: row.id, rebind: true })
              }
            >
              {zh ? '换绑会话' : 'Move to session'}
            </Button>
          </div>
          {row.unavailable && (
            <p className="channel-muted">
              {zh
                ? '此连接包含不可访问的绑定，暂不能修改。'
                : 'This connection contains an inaccessible binding and cannot be edited.'}
            </p>
          )}
        </div>
      </Disclosure>
      {message && (
        <p className="channel-connection-error" role="alert">
          {message}
        </p>
      )}
    </article>
  )
}

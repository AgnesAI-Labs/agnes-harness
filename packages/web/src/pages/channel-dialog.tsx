import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { Button, ChannelIcon, Dialog, Field, Select, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type ChannelDialogRequest, channelDialogState, closeChannelDialog } from './channel-dialog-state.js'
import { useChannelOverview } from './channel-model.js'
import { ChannelStatus, channelConnectionState } from './channel-presentation.js'
import { ChannelSetup } from './channel-setup.js'
import type { ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

export function ChannelDialogHost({ data }: { data: HomePageData }) {
  const request = useSyncExternalStore(channelDialogState.subscribe, channelDialogState.getSnapshot)
  return request ? <ChannelDialog key={JSON.stringify(request)} data={data} request={request} /> : null
}

function ChannelDialog({ data, request }: { data: HomePageData; request: ChannelDialogRequest }) {
  const zh = useDocumentLanguage() === 'zh-CN'
  const { overview, error, refresh } = useChannelOverview(data)
  const [step, setStep] = useState(1)
  const [extension, setExtension] = useState(request.extension)
  const [sessionId, setSessionId] = useState(request.sessionId ?? '')
  const [credentials, setCredentials] = useState<{ id: string; label: string }[]>([])
  const api = useMemo(() => new CredentialsApi(), [])
  useEffect(() => {
    let alive = true
    const load = () => {
      void api
        .list()
        .then((value) => {
          if (alive) setCredentials(value)
        })
        .catch(() => {})
    }
    load()
    window.addEventListener('focus', load)
    const timer = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [api])
  const group = overview?.channels.find(
    (item) => item.provider.extension === extension && item.provider.bindingAvailable && !item.error,
  )
  const session = overview?.sessions.find((item) => item.sessionId === sessionId)
  const existing = group?.instances.find((item) => item.id === request.instanceId)
  const pinned = useRef<ManagedInstance>()
  if (existing) pinned.current = existing
  const selected = existing ?? pinned.current
  const editing = !!request.instanceId
  return (
    <Dialog
      open
      size="md"
      className="channel-dialog"
      title={
        editing ? (zh ? '编辑渠道连接' : 'Edit channel connection') : zh ? '连接渠道' : 'Connect a channel'
      }
      footer={null}
      onCancel={closeChannelDialog}
      mask={{ closable: false }}
    >
      <div className="channel-dialog-body">
        {!editing && (
          <ol className="channel-steps" aria-label={zh ? '绑定步骤' : 'Binding steps'}>
            {[zh ? '选择渠道' : 'Channel', zh ? '连接机器人' : 'Connection', zh ? '绑定会话' : 'Session'].map(
              (label, index) => (
                <li key={label} data-active={index === (!group ? 0 : step)}>
                  <span>{index + 1}</span>
                  {label}
                </li>
              ),
            )}
          </ol>
        )}
        {error && (
          <p role="alert">
            {zh ? '无法读取渠道，请重试。' : 'Unable to load channels. Try again.'}
            <Button onClick={() => void refresh()}>{zh ? '重试' : 'Retry'}</Button>
          </p>
        )}
        {!overview && !error && <p role="status">{zh ? '正在读取渠道…' : 'Loading channels…'}</p>}
        {overview && !group && !editing && (
          <>
            <p className="channel-muted">
              {zh ? '将当前会话连接到你使用的聊天工具。' : 'Continue this session in your chat app.'}
            </p>
            <div className="channel-picker">
              {overview.channels.map((item) => (
                <Button
                  key={item.provider.extension}
                  className="channel-choice"
                  disabled={!item.provider.bindingAvailable || !!item.error}
                  onClick={() => setExtension(item.provider.extension)}
                >
                  <ChannelIcon className="channel-glyph" icon={item.provider.manifest.icon} />
                  <span>
                    <strong>{item.provider.manifest.displayName || item.provider.manifest.id}</strong>
                    <small>
                      {item.instances.length} {zh ? '个连接' : 'connections'}
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </Button>
              ))}
            </div>
            {!overview.channels.length && (
              <div className="channel-empty">
                {zh
                  ? '暂无可用渠道，请先安装并启用渠道插件。'
                  : 'Install and enable a channel plugin to get started.'}
              </div>
            )}
            {extension && (
              <p role="alert">
                {zh ? '所选渠道已不可用，请重新选择。' : 'This channel is unavailable. Choose another.'}
              </p>
            )}
          </>
        )}
        {overview && editing && (!group || !selected) && (
          <p role="alert">
            {zh
              ? '此渠道连接已不存在或暂不可用，请刷新后重试。'
              : 'This connection is missing or unavailable. Refresh and try again.'}
            <Button onClick={() => void refresh()}>{zh ? '刷新' : 'Refresh'}</Button>
          </p>
        )}
        {group && (!editing || selected) && (
          <>
            <div className="channel-selected">
              <ChannelIcon className="channel-glyph" icon={group.provider.manifest.icon} />
              <strong>{group.provider.manifest.displayName || group.provider.manifest.id}</strong>
              {editing && selected && (
                <ChannelStatus state={channelConnectionState(selected.connection)} zh={zh} />
              )}
              {!request.instanceId && (
                <Button appearance="ghost" onClick={() => setExtension(undefined)}>
                  {zh ? '更换' : 'Change'}
                </Button>
              )}
            </div>
            {(!request.sessionId || request.rebind) && (
              <Field label={zh ? '绑定到会话' : 'Session'}>
                <Select
                  aria-label={zh ? '绑定到会话' : 'Session'}
                  placeholder={zh ? '选择会话' : 'Choose a session'}
                  value={sessionId || null}
                  options={(overview?.sessions ?? [])
                    .filter((item) => !!item.cwd)
                    .map((item) => ({ value: item.sessionId, label: item.title || item.sessionId }))}
                  onChange={(id: string) => setSessionId(id)}
                />
              </Field>
            )}
            {request.sessionId && !session && (
              <p role="alert">
                {zh ? '当前会话不可用，请先发送消息创建会话。' : 'Send a message to create a session first.'}
              </p>
            )}
            {!sessionId && (
              <p className="channel-muted">
                {zh
                  ? '选择一个已有会话，或先返回聊天发送第一条消息。'
                  : 'Choose an existing session, or send your first message in chat.'}
              </p>
            )}
            {session && (
              <ChannelSetup
                key={`${group.provider.extension}:${sessionId}:${request.instanceId ?? ''}`}
                data={data}
                group={error ? { ...group, error: true } : group}
                sessionId={sessionId}
                existing={selected}
                credentials={credentials}
                zh={zh}
                onStage={setStep}
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

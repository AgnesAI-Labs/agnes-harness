import { Button, ChannelIcon, SettingsInput, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { openChannelDialog } from './channel-dialog-state.js'
import { channelsChanged, useChannelOverview } from './channel-model.js'
import { channelName } from './channel-name.js'
import { ChannelStatus, channelConnectionState } from './channel-presentation.js'
import type { ChannelGroup, ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

export function ChannelsPanel({ data }: { data: HomePageData }) {
  const zh = useDocumentLanguage() === 'zh-CN'
  const { overview, error, refresh } = useChannelOverview(data)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const groups = overview?.channels ?? []
  const instances = groups.flatMap((group) => group.instances)
  const matches = (row: ManagedInstance) =>
    [
      row.id,
      row.workspace,
      row.intendedSession?.title,
      ...row.bindings.flatMap((binding) => [binding.sessionTitle, binding.label]),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase())
  return (
    <section className="channel-page" data-testid="channels-panel">
      <header className="channel-page-heading">
        <div>
          <h2>{zh ? '让会话连接更多地方' : 'Your sessions, connected'}</h2>
          <p>
            {zh
              ? '在聊天工具中继续会话，在这里管理每个连接的去向。'
              : 'Continue in your chat apps. Manage where each connection leads.'}
          </p>
        </div>
        <Button appearance="primary" onClick={() => openChannelDialog({ sessionId: data.sessionId() })}>
          {zh ? '新增连接' : 'Add connection'}
        </Button>
      </header>
      <div className="channel-metrics">
        <span>
          <strong>{groups.length}</strong>
          {zh ? '个可用渠道' : 'channels'}
        </span>
        <span>
          <strong>{instances.length}</strong>
          {zh ? '个机器人连接' : 'connections'}
        </span>
        <span>
          <strong>{instances.reduce((sum, row) => sum + row.bindings.length, 0)}</strong>
          {zh ? '个会话绑定' : 'session bindings'}
        </span>
      </div>
      <div className="channel-toolbar">
        <fieldset className="channel-filters" aria-label={zh ? '筛选渠道' : 'Filter channels'}>
          <Button
            appearance={filter === 'all' ? 'primary' : 'ghost'}
            size="small"
            onClick={() => setFilter('all')}
          >
            {zh ? '全部渠道' : 'All channels'}
          </Button>
          {groups.map((group) => (
            <Button
              key={group.provider.extension}
              size="small"
              appearance={filter === group.provider.extension ? 'primary' : 'ghost'}
              onClick={() => setFilter(group.provider.extension)}
            >
              {channelName(group.provider.manifest, zh)}
              <span className="channel-count">{group.instances.length}</span>
            </Button>
          ))}
        </fieldset>
        <SettingsInput
          aria-label={zh ? '搜索会话或连接' : 'Search sessions or connections'}
          placeholder={zh ? '搜索会话、聊天对象…' : 'Search sessions, chats…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button appearance="ghost" onClick={() => void refresh()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </div>
      {error && (
        <p role="alert">{zh ? '渠道读取失败，请刷新重试。' : 'Unable to load channels. Refresh to retry.'}</p>
      )}
      {!overview && !error && <p role="status">{zh ? '正在读取连接…' : 'Loading connections…'}</p>}
      {overview && !groups.length && (
        <div className="channel-empty">
          <h3>{zh ? '还没有渠道插件' : 'No channel plugins yet'}</h3>
          <p>
            {zh
              ? '安装并启用渠道插件后，它们会自动出现在这里和会话绑定窗口中。'
              : 'Installed and enabled channel plugins appear here and in the binding dialog automatically.'}
          </p>
        </div>
      )}
      {groups
        .filter((group) => filter === 'all' || filter === group.provider.extension)
        .map((group) => (
          <section
            key={group.provider.extension}
            className="channel-group"
            data-testid={`channel-provider-${group.provider.manifest.id}`}
          >
            <div className="channel-group-heading">
              <ChannelIcon className="channel-glyph" icon={group.provider.manifest.icon} />
              <div>
                <h3>{channelName(group.provider.manifest, zh)}</h3>
                <small>
                  {group.instances.length} {zh ? '个连接' : 'connections'}
                </small>
              </div>
              <Button
                appearance="ghost"
                size="small"
                disabled={group.error || !group.provider.bindingAvailable}
                onClick={() =>
                  openChannelDialog({ sessionId: data.sessionId(), extension: group.provider.extension })
                }
              >
                {zh ? '添加连接' : 'Add connection'}
              </Button>
            </div>
            {group.error ? (
              <p role="alert">
                {zh ? '此渠道状态不可用，请刷新。' : 'Channel status unavailable. Refresh to retry.'}
              </p>
            ) : !group.instances.length ? (
              <div className="channel-empty channel-empty--compact">
                {zh
                  ? '暂无连接。从会话中点击“渠道绑定”，即可开始。'
                  : 'No connections. Choose Channels in a session to get started.'}
              </div>
            ) : (
              <div className="channel-connection-grid">
                {group.instances.filter(matches).map((row) => (
                  <ConnectionCard key={row.id} data={data} group={group} row={row} zh={zh} />
                ))}
              </div>
            )}
            {!!group.instances.length && !group.instances.some(matches) && (
              <p className="channel-muted">{zh ? '没有匹配的连接' : 'No matching connections'}</p>
            )}
          </section>
        ))}
    </section>
  )
}

function ConnectionCard({
  data,
  group,
  row,
  zh,
}: {
  data: HomePageData
  group: ChannelGroup
  row: ManagedInstance
  zh: boolean
}) {
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
  return (
    <article className="channel-connection">
      <div className="channel-connection-top">
        <span className="channel-eyebrow">{zh ? '机器人连接' : 'BOT CONNECTION'}</span>
        <ChannelStatus state={channelConnectionState(row.connection)} zh={zh} />
      </div>
      {row.bindings.length ? (
        row.bindings.map((binding) => (
          <div className="channel-session-link" key={binding.targetId}>
            <small>{zh ? '绑定会话' : 'SESSION'}</small>
            <a href={`?session=${encodeURIComponent(binding.sessionId)}`}>
              {binding.sessionTitle}
              <span aria-hidden="true">↗</span>
            </a>
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
            <Button
              appearance="ghost"
              size="small"
              disabled={busy || row.unavailable}
              onClick={() => void unbind(binding.sessionId)}
            >
              {zh ? '解绑' : 'Unbind'}
            </Button>
          </div>
        ))
      ) : (
        <div className="channel-session-link">
          <small>{zh ? '待绑定会话' : 'NOT BOUND'}</small>
          <strong>{row.intendedSession?.title || (zh ? '尚未选择会话' : 'Choose a session')}</strong>
          <span>{zh ? '选择聊天对象后开始同步' : 'Choose a chat to start sharing messages'}</span>
        </div>
      )}
      <div className="channel-connection-meta">
        <span title={row.workspace}>{row.workspace}</span>
        <code title={row.id}>{row.id}</code>
      </div>
      <div className="channel-card-actions">
        <Button
          size="small"
          disabled={busy || !!pending.current || row.unavailable || !group.provider.bindingAvailable}
          onClick={() =>
            openChannelDialog({ extension: group.provider.extension, instanceId: row.id, sessionId })
          }
        >
          {zh ? '配置与绑定' : 'Configure and bind'}
        </Button>
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
      {message && <p role="alert">{message}</p>}
    </article>
  )
}

import { Button, ChannelIcon, Disclosure, SettingsInput, useDocumentLanguage } from '@agnes/web-ui'
import { useState } from 'react'
import { ConnectionCard } from './channel-connection.js'
import { openChannelDialog } from './channel-dialog-state.js'
import { useChannelOverview } from './channel-model.js'
import { channelName } from './channel-name.js'
import { channelConnectionState } from './channel-presentation.js'
import type { ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

const PREVIEW_COUNT = 3
export function ChannelsPanel({ data }: { data: HomePageData }) {
  const zh = useDocumentLanguage() === 'zh-CN'
  const { overview, error, refresh } = useChannelOverview(data)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const groups = overview?.channels ?? []
  const instances = groups.flatMap((group) => group.instances)
  const search = query.trim().toLocaleLowerCase()
  const matches = (row: ManagedInstance) =>
    [
      row.id,
      row.workspace,
      row.intendedSession?.title,
      ...row.bindings.flatMap((binding) => [binding.sessionTitle, binding.label]),
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(search)
  const selectedGroups = groups.filter((group) => filter === 'all' || filter === group.provider.extension)
  const visibleGroups = search
    ? selectedGroups.filter((group) => group.instances.some(matches))
    : selectedGroups
  const toggleAll = (closed: boolean) => {
    setCollapsed((previous) => ({
      ...previous,
      ...Object.fromEntries(selectedGroups.map((group) => [group.provider.extension, closed])),
    }))
    if (!closed)
      setShowAll((previous) => ({
        ...previous,
        ...Object.fromEntries(selectedGroups.map((group) => [group.provider.extension, true])),
      }))
  }
  return (
    <section className="channel-page" data-testid="channels-panel">
      <header className="channel-page-heading">
        <div>
          <h2>{zh ? '渠道连接' : 'Channel connections'}</h2>
          <p>
            {zh
              ? '查看每个机器人连接的会话与同步状态。'
              : 'See where each bot connects and what is being shared.'}
          </p>
        </div>
        <Button appearance="primary" onClick={() => openChannelDialog({ sessionId: data.sessionId() })}>
          {zh ? '新增连接' : 'Add connection'}
        </Button>
      </header>
      <div className="channel-metrics">
        <span>
          <strong>{groups.length}</strong>
          {zh ? '个渠道' : 'channels'}
        </span>
        <span>
          <strong>{instances.length}</strong>
          {zh ? '个连接' : 'connections'}
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
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            {zh ? '全部渠道' : 'All channels'}
          </Button>
          {groups.map((group) => (
            <Button
              key={group.provider.extension}
              size="small"
              appearance={filter === group.provider.extension ? 'primary' : 'ghost'}
              aria-pressed={filter === group.provider.extension}
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
        <Button appearance="ghost" size="small" onClick={() => void refresh()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </div>
      {!!groups.length && (
        <div className="channel-list-tools">
          <span>
            {search
              ? zh
                ? `找到 ${visibleGroups.reduce((sum, group) => sum + group.instances.filter(matches).length, 0)} 个匹配连接`
                : `${visibleGroups.reduce((sum, group) => sum + group.instances.filter(matches).length, 0)} matching connections`
              : zh
                ? '按渠道分组 · 展开详情以查看完整配置'
                : 'Grouped by channel · Open details for full configuration'}
          </span>
          {search ? (
            <Button appearance="ghost" size="small" onClick={() => setQuery('')}>
              {zh ? '清除搜索' : 'Clear search'}
            </Button>
          ) : (
            <div>
              <Button appearance="ghost" size="small" onClick={() => toggleAll(false)}>
                {zh ? '全部展开' : 'Expand all'}
              </Button>
              <Button appearance="ghost" size="small" onClick={() => toggleAll(true)}>
                {zh ? '全部收起' : 'Collapse all'}
              </Button>
            </div>
          )}
        </div>
      )}
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
      {!!groups.length && !visibleGroups.length && (
        <div className="channel-empty" role="status">
          {zh ? '没有匹配的连接，试试其他关键词。' : 'No matching connections. Try another search.'}
        </div>
      )}
      {visibleGroups.map((group) => {
        const key = group.provider.extension,
          name = channelName(group.provider.manifest, zh)
        const rows = group.instances.filter(matches),
          showingAll = !!search || showAll[key]
        const connected = group.instances.filter(
          (row) => channelConnectionState(row.connection) === 'connected',
        ).length
        return (
          <section
            key={key}
            className="channel-group-shell"
            aria-label={name}
            data-testid={`channel-provider-${group.provider.manifest.id}`}
          >
            <Disclosure
              className="channel-group"
              variant="card"
              open={!!search || !collapsed[key]}
              onOpenChange={(open) => setCollapsed((previous) => ({ ...previous, [key]: !open }))}
              summaryProps={{ 'aria-label': `${name} ${zh ? '连接' : 'connections'}`, disabled: !!search }}
              summary={
                <span className="channel-group-identity">
                  <ChannelIcon className="channel-glyph" icon={group.provider.manifest.icon} />
                  <span className="channel-group-name">
                    {name}
                    <small>
                      {group.instances.length} {zh ? '个连接' : 'connections'}
                    </small>
                  </span>
                </span>
              }
              meta={
                group.error ? (
                  <span className="channel-group-warning">{zh ? '状态不可用' : 'Status unavailable'}</span>
                ) : (
                  <span className="channel-group-counts">
                    {connected}/{group.instances.length} {zh ? '已连接' : 'connected'}
                  </span>
                )
              }
            >
              {group.error ? (
                <p className="channel-group-error" role="alert">
                  {zh ? '此渠道状态不可用，请刷新。' : 'Channel status unavailable. Refresh to retry.'}
                </p>
              ) : !group.instances.length ? (
                <div className="channel-empty channel-empty--compact">
                  {zh
                    ? '暂无连接。从会话中点击“渠道绑定”，即可开始。'
                    : 'No connections. Choose Channels in a session to get started.'}
                </div>
              ) : (
                <>
                  <div className="channel-connection-list">
                    {rows.map((row, index) => (
                      <ConnectionCard
                        key={row.id}
                        data={data}
                        group={group}
                        row={row}
                        hidden={!showingAll && index >= PREVIEW_COUNT}
                      />
                    ))}
                  </div>
                  {rows.length > PREVIEW_COUNT && !search && (
                    <div className="channel-show-more">
                      <Button
                        appearance="ghost"
                        size="small"
                        onClick={() => setShowAll((previous) => ({ ...previous, [key]: !previous[key] }))}
                      >
                        {showingAll
                          ? zh
                            ? '收起更多连接'
                            : 'Show fewer connections'
                          : zh
                            ? `查看其余 ${rows.length - PREVIEW_COUNT} 个连接`
                            : `Show ${rows.length - PREVIEW_COUNT} more connections`}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Disclosure>
            <Button
              className="channel-group-add"
              appearance="ghost"
              size="small"
              disabled={group.error || !group.provider.bindingAvailable}
              aria-label={`${zh ? '添加连接' : 'Add connection'}: ${name}`}
              onClick={() => openChannelDialog({ sessionId: data.sessionId(), extension: key })}
            >
              {zh ? '添加连接' : 'Add connection'}
            </Button>
          </section>
        )
      })}
    </section>
  )
}

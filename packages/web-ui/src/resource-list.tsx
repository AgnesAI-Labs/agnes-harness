import type { SkillDescriptor, SkillRootStatus } from '@agnes/protocol'
import type { JSX } from 'react'
import { StateLights, StateSwitch, type StateTone } from './ui/state-lights.js'

export type ResourceItem = SkillDescriptor | import('@agnes/protocol').McpServerDescriptor

export type ResourceTab = 'skills' | 'mcp'

export type ResourceLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/** 列表区整体内容：加载/错误（含重试）/来源扫描/空态/行/加载更多。宿主 `#resource-list` 即挂载点。 */
export function ResourceListContent({
  tab,
  loadState,
  items,
  skillRoots,
  selectedId,
  nextCursor,
  loadingMore,
  emptyTitle,
  emptyDescription,
  emptyHints,
  switchDisabled,
  itemNameOf,
  onOpen,
  onToggleDesired,
  onLoadMore,
  onRetry,
}: {
  tab: ResourceTab
  loadState: ResourceLoadState
  items: readonly ResourceItem[]
  skillRoots: readonly SkillRootStatus[]
  selectedId: string | undefined
  nextCursor: string | undefined
  loadingMore: boolean
  emptyTitle: string
  emptyDescription: string
  emptyHints?: readonly string[] | undefined
  switchDisabled: boolean
  itemNameOf(item: ResourceItem): string
  onOpen(item: ResourceItem): void
  onToggleDesired(item: ResourceItem, next: boolean): void
  onLoadMore(): void
  onRetry(): void
}): JSX.Element {
  if (loadState === 'loading' && !items.length) {
    return <p className="plugin-empty">正在读取本地资源目录…</p>
  }
  if (loadState === 'error') {
    return (
      <p className="plugin-empty">
        资源目录读取失败。
        <button type="button" className="secondary-button compact" data-resource-retry onClick={onRetry}>
          重试读取
        </button>
      </p>
    )
  }
  return (
    <>
      {tab === 'skills' && skillRoots.length > 0 && <ResourceRoots roots={skillRoots} />}
      {!items.length && (
        <ResourceEmpty
          tab={tab}
          title={emptyTitle}
          description={emptyDescription}
          hints={tab === 'skills' ? emptyHints : undefined}
        />
      )}
      {items.map((item) => (
        <ResourceRow
          key={item.resourceId}
          item={item}
          selected={item.resourceId === selectedId}
          switchDisabled={switchDisabled}
          itemName={itemNameOf(item)}
          onOpen={onOpen}
          onToggleDesired={onToggleDesired}
        />
      ))}
      {nextCursor && (
        <button
          type="button"
          className="secondary-button compact"
          aria-busy={loadingMore}
          onClick={onLoadMore}
        >
          加载更多
        </button>
      )}
    </>
  )
}

/** 语义色档与现有 token 契约保持一致；颜色不进 JS。 */
const safeStatus = (value: string): string =>
  (
    ({
      ready: '已就绪',
      disabled: '已停用',
      unavailable: '不可用',
      degraded: '异常',
      preparing: '准备中',
      connecting: '连接中',
      enabled: '已启用',
      untrusted: '未信任',
      trusted: '已信任',
      rejected: '已拒绝',
    }) as Record<string, string>
  )[value] ?? value

const trustTone = (trust: string): StateTone =>
  trust === 'trusted' ? 'ok' : trust === 'rejected' ? 'bad' : 'warn'
const desiredTone = (desired: string): StateTone => (desired === 'enabled' ? 'ok' : 'off')
function actualTone(actual: string): StateTone {
  if (actual === 'ready' || actual === 'enabled') return 'ok'
  if (actual === 'disabled') return 'off'
  if (actual === 'preparing' || actual === 'connecting' || actual === 'degraded') return 'warn'
  if (actual === 'unavailable' || actual === 'rejected' || actual === 'failed') return 'bad'
  return 'unknown'
}

export const ROOT_FAILURE_COPY: Record<NonNullable<SkillRootStatus['diagnostic']>['code'], string> = {
  'root-unreadable': '目录读不到',
  'root-unresolvable': '目录位置无法解析',
  'entry-limit': '目录里的条目数超过上限',
  'root-bytes-limit': '目录内容超过体积上限',
  'workspace-key-missing': '缺少工作区标识',
  'entry-outside-root': '有条目指向该来源之外',
  'skill-file-unreadable': 'SKILL.md 读不到或大小不合法',
  'skill-body-too-large': 'SKILL.md 正文超过体积上限',
  'invalid-frontmatter': '有 SKILL.md 的 frontmatter 不合法（常见：description 为空）',
  'entries-skipped': '部分条目不合规，已跳过',
}

/**
 * 来源扫描状态：默认只占一行摘要，展开才看每个来源。
 * 文案面向用户，不暴露实现视角的措辞。
 */
export function ResourceRoots({ roots }: { roots: readonly SkillRootStatus[] }): JSX.Element {
  const counts = { ready: 0, empty: 0, failed: 0 }
  for (const root of roots) {
    if (root.state === 'ready') counts.ready += 1
    else if (root.state === 'empty') counts.empty += 1
    else counts.failed += 1
  }
  const labels: Record<SkillRootStatus['state'], string> = {
    ready: '已扫描',
    empty: '未发现技能',
    stale: '刷新失败 · 正在使用上次成功的结果',
    unavailable: '刷新失败 · 本次没有可用结果',
  }
  return (
    <details className="resource-roots">
      <summary>
        {[
          `技能来源 ${roots.length} 个`,
          `已扫描 ${counts.ready}`,
          `未发现技能 ${counts.empty}`,
          counts.failed ? `失败 ${counts.failed}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </summary>
      <ul>
        {roots.map((root) => (
          <li key={`${root.scope}:${root.rootKey}`}>
            {`${root.scope} · ${root.rootKey}：${labels[root.state]}${
              root.diagnostic ? `（${ROOT_FAILURE_COPY[root.diagnostic.code]}）` : ''
            }`}
          </li>
        ))}
      </ul>
    </details>
  )
}

export function ResourceEmpty({
  tab,
  title,
  description,
  hints,
}: {
  tab: ResourceTab
  title: string
  description: string
  hints?: readonly string[] | undefined
}): JSX.Element {
  return (
    <div className="admin-empty-state resource-empty">
      <span className="agnes-mark admin-empty-state-mark" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {tab === 'skills' && hints?.length ? (
        <ul className="admin-empty-state-hints">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function ResourceRow({
  item,
  selected,
  switchDisabled,
  itemName,
  onOpen,
  onToggleDesired,
}: {
  item: ResourceItem
  selected: boolean
  switchDisabled: boolean
  itemName: string
  onOpen(item: ResourceItem): void
  onToggleDesired(item: ResourceItem, next: boolean): void
}): JSX.Element {
  const enabled = item.desired === 'enabled'
  return (
    <article
      className="plugin-row resource-row"
      data-resource-id={item.resourceId}
      tabIndex={0}
      role="button"
      data-selected={String(selected)}
      aria-pressed={selected}
      aria-label={`查看 ${itemName} 的详情`}
      onClick={(event) => {
        // 行内 Switch 自己处理点击（并已 stopPropagation）；这里再挡一次，
        // 因为置灰的按钮在部分浏览器里不发 click，事件会落到行上。
        if (event.target instanceof Element && event.target.closest('.switch')) return
        onOpen(item)
      }}
      onKeyDown={(event) => {
        // 行内控件的按键会冒泡到行：焦点在 Switch 上按空格是拨开关，不是打开详情。
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
    >
      <div className="plugin-row-content">
        <h2 title={itemName}>{itemName}</h2>
        {item.kind === 'skill' ? (
          <>
            <p>{item.description ?? '该 Skill 未提供说明。'}</p>
            <p className="plugin-source">
              {`${item.sourceIdentity.rootKey} · 优先级 ${item.priority} · ${item.resolution.winner ? '当前 winner' : '非 winner'}`}
            </p>
          </>
        ) : (
          <>
            <p>{`${item.serverId} · ${item.transportKind.toUpperCase()}`}</p>
            <p className="plugin-source">
              {`凭据 ${item.secretBindingKind} · ${
                item.definition.toolPolicy?.allow?.length
                  ? `允许 ${item.definition.toolPolicy.allow.length} 个工具`
                  : '未限制工具'
              }`}
            </p>
          </>
        )}
      </div>
      <StateLights
        states={[
          {
            label: '信任',
            value: safeStatus(item.trust),
            tone: trustTone(item.trust),
          },
          {
            label: '期望',
            value: safeStatus(item.desired),
            tone: desiredTone(item.desired),
          },
          {
            label: '实际',
            value: safeStatus(item.actual),
            tone: actualTone(item.actual),
          },
        ]}
      />
      <StateSwitch
        label={enabled ? `请求停用 ${itemName}` : `请求启用 ${itemName}`}
        checked={enabled}
        disabled={switchDisabled}
        onToggle={(next) => onToggleDesired(item, next)}
      />
    </article>
  )
}

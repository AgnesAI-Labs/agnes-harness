import type { SkillDescriptor, SkillRootStatus } from '@agnes/protocol'
import type { JSX } from 'react'
import { RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog } from './locales/resource-list.js'
import { StateSwitch } from './ui/state-lights.js'
import { useUiText } from './ui-locale.js'

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
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  if (loadState === 'loading' && !items.length) {
    return <p className="plugin-empty">{t('loading')}</p>
  }
  if (loadState === 'error') {
    return (
      <p className="plugin-empty">
        {t('error')}
        <button type="button" className="secondary-button compact" data-resource-retry onClick={onRetry}>
          {t('retry')}
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
          title={tab === 'skills' ? t('empty.skills.title') : emptyTitle}
          description={tab === 'skills' ? t('empty.skills.description') : emptyDescription}
          hints={tab === 'skills' ? skillRoots.map((root) => t(`root.location.${root.rootKey}`)) : undefined}
          footer={
            tab === 'skills'
              ? t(
                  skillRoots.some((root) =>
                    ['user-agents', 'user-claude', 'user-codex'].includes(root.rootKey),
                  )
                    ? 'empty.skills.importEnabled'
                    : 'empty.skills.import',
                )
              : undefined
          }
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
          {t('load-more')}
        </button>
      )}
    </>
  )
}

/**
 * 开关表达用户意图（期望状态），与后端的 `desired` 同义：后端按它决定要不要继续拉起资源，
 * 也按它决定资源能不能被移除。实际有没有跑起来由行内的失败原因说明，不靠开关冒充。
 */
export function resourceDesiredEnabled(item: ResourceItem): boolean {
  return item.desired === 'enabled'
}

export const ROOT_FAILURE_KEYS: Record<NonNullable<SkillRootStatus['diagnostic']>['code'], string> = {
  'root-unreadable': 'root.root-unreadable',
  'root-unresolvable': 'root.root-unresolvable',
  'entry-limit': 'root.entry-limit',
  'root-bytes-limit': 'root.root-bytes-limit',
  'workspace-key-missing': 'root.workspace-key-missing',
  'entry-outside-root': 'root.entry-outside-root',
  'skill-file-unreadable': 'root.skill-file-unreadable',
  'skill-body-too-large': 'root.skill-body-too-large',
  'invalid-frontmatter': 'root.invalid-frontmatter',
  'entries-skipped': 'root.entries-skipped',
}

/**
 * 来源扫描状态：默认只占一行摘要，展开才看每个来源。
 * 文案面向用户，不暴露实现视角的措辞。
 */
export function ResourceRoots({ roots }: { roots: readonly SkillRootStatus[] }): JSX.Element {
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  const counts = { ready: 0, empty: 0, failed: 0 }
  for (const root of roots) {
    if (root.state === 'ready') counts.ready += 1
    else if (root.state === 'empty') counts.empty += 1
    else counts.failed += 1
  }
  const labels: Record<SkillRootStatus['state'], string> = {
    ready: t('root.ready'),
    empty: t('root.empty'),
    stale: t('root.stale'),
    unavailable: t('root.unavailable'),
  }
  return (
    <details className="resource-roots">
      <summary>
        {[
          t('root.source-count', { count: roots.length }),
          t('root.ready-count', { count: counts.ready }),
          t('root.empty-count', { count: counts.empty }),
          counts.failed ? t('root.failed-count', { count: counts.failed }) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </summary>
      <ul>
        {roots.map((root) => (
          <li key={`${root.scope}:${root.rootKey}`}>
            {`${t(`root.scope.${root.scope}`)} · ${t(`root.location.${root.rootKey}`)}: ${labels[root.state]}${
              root.diagnostic ? ` (${t(ROOT_FAILURE_KEYS[root.diagnostic.code])})` : ''
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
  footer,
}: {
  tab: ResourceTab
  title: string
  description: string
  hints?: readonly string[] | undefined
  footer?: string | undefined
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
      {footer && <p>{footer}</p>}
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
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  const enabled = resourceDesiredEnabled(item)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: The heading button owns the keyboard action; the row pointer hit area does not nest interactive roles.
    <article
      className="plugin-row resource-row"
      data-resource-id={item.resourceId}
      data-selected={String(selected)}
      onClick={(event) => {
        // 行内 Switch 自己处理点击（并已 stopPropagation）；这里再挡一次，
        // 因为置灰的按钮在部分浏览器里不发 click，事件会落到行上。
        if (event.target instanceof Element && event.target.closest('.switch, button, a')) return
        onOpen(item)
      }}
    >
      <div className="plugin-row-content">
        <h2 title={itemName}>
          <button
            type="button"
            className="plugin-details-button"
            aria-pressed={selected}
            aria-label={t('row.open-aria', { name: itemName })}
            onClick={() => onOpen(item)}
          >
            {itemName}
          </button>
        </h2>
        {item.kind === 'skill' ? (
          <>
            <p>{item.description ?? t('row.skill-no-description')}</p>
            <p className="plugin-source">
              {`${item.sourceIdentity.rootKey} · ${t('row.priority', { priority: item.priority })} · ${t(item.resolution.winner ? 'row.winner' : 'row.not-winner')}`}
            </p>
          </>
        ) : (
          <>
            <p>{`${item.serverId} · ${item.transportKind.toUpperCase()}`}</p>
            <p className="plugin-source">
              {`${t('row.secret', { kind: item.secretBindingKind })} · ${
                item.definition.toolPolicy?.allow?.length
                  ? t('row.tools-allowed', { count: item.definition.toolPolicy.allow.length })
                  : t('row.tools-unrestricted')
              }`}
            </p>
          </>
        )}
        {item.lastSafeError && (
          <p className="resource-safe-error">
            {t('row.safe-error', {
              code: item.lastSafeError.code,
              message: resourceFailureLabel(item.lastSafeError.code, t),
            })}
          </p>
        )}
      </div>
      <StateSwitch
        label={t(enabled ? 'row.disable' : 'row.enable', { name: itemName })}
        checked={enabled}
        disabled={switchDisabled}
        onToggle={(next) => onToggleDesired(item, next)}
      />
    </article>
  )
}

import { resourceFailureLabel } from './resource-failure.js'

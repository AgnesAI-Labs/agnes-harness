import type { SkillDescriptor, SkillRootStatus } from '@agnes/protocol'
import { type JSX, memo } from 'react'
import { RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog } from './locales/resource-list.js'
import { McpConnectionRow, type McpRowActions } from './mcp-connection-row.js'
import { SettingsList, SettingsState, SettingsToolbar } from './settings-layout.js'
import { Button } from './ui/button.js'
import { Disclosure } from './ui/disclosure.js'
import { EmptyState } from './ui/empty-state.js'
import { Icon } from './ui/icon.js'
import { IconButton } from './ui/icon-button.js'
import { ListRow } from './ui/list-row.js'
import { Menu, type MenuItem } from './ui/menu.js'
import { StateSwitch } from './ui/state-lights.js'
import { MetaText, Tag } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

let packageNames: ((id: string) => string | undefined) | undefined
/**
 * The page that lists plugins tells the resource list how to name one, so a skill row can say
 * which plugin it comes from. The list is drawn by a controller in its own root, out of reach of
 * the page's props; without a resolver the row says only that the skill comes from a plugin.
 */
export function setResourcePackageNames(resolve: ((id: string) => string | undefined) | undefined): void {
  packageNames = resolve
}

let skillRunner: ((name: string) => void) | undefined
/**
 * The plugins page offers 「在新会话中运行」 on each skill that is on: it registers what running a
 * skill does (ask for arguments, then open a new session), since the list's controller cannot
 * reach the page. Without a runner the row offers no such action.
 */
export function setResourceSkillRunner(run: ((name: string) => void) | undefined): void {
  skillRunner = run
}

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
  mcpActions,
  onImport,
  filtered = false,
  menuOf,
  busy = false,
  busyResourceId,
}: {
  busyResourceId?: string | undefined
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
  mcpActions?(item: import('@agnes/protocol').McpServerDescriptor): McpRowActions
  onImport?(): void
  filtered?: boolean
  busy?: boolean
  menuOf?(item: ResourceItem): readonly MenuItem[]
}): JSX.Element {
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  if (loadState === 'loading' && !items.length) {
    return (
      <SettingsState tone="loading" className="plugin-empty">
        {t('loading')}
      </SettingsState>
    )
  }
  if (loadState === 'error' && !items.length) {
    return (
      <SettingsState tone="error" className="plugin-empty">
        {t('error')}
        <SettingsToolbar>
          <Button htmlType="button" size="small" data-resource-retry onClick={onRetry}>
            {t('retry')}
          </Button>
        </SettingsToolbar>
      </SettingsState>
    )
  }
  return (
    <>
      {loadState === 'error' && (
        <SettingsState tone="error">
          {t('error')}
          <Button onClick={onRetry}>{t('retry')}</Button>
        </SettingsState>
      )}
      {tab === 'skills' &&
        skillRoots
          .filter((root) => root.state === 'unavailable' || root.state === 'stale')
          .map((root) => (
            <ListRow
              key={`${root.scope}:${root.rootKey}`}
              title={t(`root.scope.${root.scope}`)}
              description={
                root.diagnostic ? t(ROOT_FAILURE_KEYS[root.diagnostic.code]) : t('skills.readFailed')
              }
              status={<Tag tone="bad">{t('skills.readFailed')}</Tag>}
              actions={
                <Button size="small" onClick={onRetry}>
                  {t('retry')}
                </Button>
              }
            />
          ))}
      {!items.length && (
        <ResourceEmpty
          tab={tab}
          title={filtered ? t('skills.noMatches') : tab === 'skills' ? t('empty.skills.title') : emptyTitle}
          description={
            filtered
              ? t('skills.adjustSearch')
              : tab === 'skills'
                ? t('empty.skills.description')
                : emptyDescription
          }
          actions={
            tab === 'skills' && !filtered ? (
              <>
                <Button href={`/?${new URLSearchParams({ new: '1', prompt: t('skills.creatorPrompt') })}`}>
                  {t('skills.create')}
                </Button>
                <Button onClick={onImport}>{t('skills.import')}</Button>
              </>
            ) : undefined
          }
        />
      )}
      {items.length > 0 && (
        <fieldset
          disabled={busy && !!busyResourceId}
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          <SettingsList>
            {items.map((item) =>
              item.kind === 'mcp' ? (
                <McpConnectionRow
                  key={item.resourceId}
                  item={item}
                  itemName={itemNameOf(item)}
                  selected={item.resourceId === selectedId}
                  disabled={switchDisabled}
                  onOpen={() => onOpen(item)}
                  onToggle={(next) => onToggleDesired(item, next)}
                  actions={mcpActions?.(item)}
                />
              ) : (
                <ResourceRow
                  key={item.resourceId}
                  item={item}
                  selected={item.resourceId === selectedId}
                  switchDisabled={switchDisabled || (busy && item.resourceId === busyResourceId)}
                  itemName={itemNameOf(item)}
                  sourceName={
                    item.kind === 'skill' && item.sourceIdentity.scope === 'package'
                      ? packageNames?.(item.sourceIdentity.sourceId)
                      : undefined
                  }
                  onOpen={onOpen}
                  onToggleDesired={onToggleDesired}
                  busy={busy && (!busyResourceId || item.resourceId === busyResourceId)}
                  menuOf={menuOf}
                  runnerAvailable={!!skillRunner}
                />
              ),
            )}
          </SettingsList>
        </fieldset>
      )}
      {nextCursor && (
        <Button htmlType="button" size="small" aria-busy={loadingMore} onClick={onLoadMore}>
          {t('load-more')}
        </Button>
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
  const { t, locale } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  const counts = { ready: 0, empty: 0, failed: 0 }
  for (const root of roots) {
    if (root.state === 'ready') counts.ready += 1
    else if (root.state === 'empty') counts.empty += 1
    else counts.failed += 1
  }
  const checked = counts.ready + counts.empty
  const summaryKey = !roots.length
    ? 'none'
    : counts.failed === roots.length
      ? 'failed'
      : counts.failed
        ? counts.ready
          ? 'partialFound'
          : 'partialEmpty'
        : counts.ready
          ? 'found'
          : 'empty'
  const summarySuffix = checked === 1 && summaryKey !== 'failed' ? '.one' : ''
  const labels: Record<SkillRootStatus['state'], string> = {
    ready: t('root.ready'),
    empty: t('root.empty'),
    stale: t('root.stale'),
    unavailable: t('root.unavailable'),
  }
  return (
    <Disclosure
      variant="plain"
      className="resource-roots"
      summary={t(`root.summary.${summaryKey}${summarySuffix}`, {
        count: new Intl.NumberFormat(locale).format(counts.ready + counts.empty),
        found: new Intl.NumberFormat(locale).format(counts.ready),
        failed: new Intl.NumberFormat(locale).format(counts.failed),
      })}
    >
      <ul>
        {roots.map((root) => (
          <li key={`${root.scope}:${root.rootKey}`}>
            {`${t(`root.scope.${root.scope}`)} · ${t(`root.location.${root.rootKey}`)}: ${labels[root.state]}${
              root.diagnostic ? ` (${t(ROOT_FAILURE_KEYS[root.diagnostic.code])})` : ''
            }`}
          </li>
        ))}
      </ul>
    </Disclosure>
  )
}

export function ResourceEmpty({
  tab,
  title,
  description,
  actions,
}: {
  tab: ResourceTab
  title: string
  description: string
  hints?: readonly string[] | undefined
  footer?: string | undefined
  actions?: import('react').ReactNode
}): JSX.Element {
  return (
    <EmptyState
      className="admin-empty-state resource-empty"
      icon={<Icon name={tab === 'skills' ? 'file-text' : 'plug'} size={48} />}
      title={title}
      description={description}
      actions={actions}
    />
  )
}

function ResourceRowContent({
  item,
  selected,
  switchDisabled,
  itemName,
  onOpen,
  onToggleDesired,
  menuItems,
  menuOf,
  busy = false,
  runnerAvailable = !!skillRunner,
  sourceName,
}: {
  /** The plugin a skill comes from, by the name people know it. */
  sourceName?: string | undefined
  runnerAvailable?: boolean | undefined
  item: ResourceItem
  selected: boolean
  switchDisabled: boolean
  itemName: string
  onOpen(item: ResourceItem): void
  onToggleDesired(item: ResourceItem, next: boolean): void
  busy?: boolean
  menuItems?: readonly MenuItem[] | undefined
  menuOf?: ((item: ResourceItem) => readonly MenuItem[]) | undefined
}): JSX.Element {
  const { t } = useUiText(RESOURCE_LIST_LOCALE_NAMESPACE, resourceListLocaleCatalog)
  const enabled = resourceDesiredEnabled(item)
  if (item.kind === 'skill')
    return (
      <ListRow
        className="plugin-row resource-row"
        data-resource-id={item.resourceId}
        data-selected={String(selected)}
        titleClassName="plugin-details-button"
        titleLabel={t('row.open-aria', { name: itemName })}
        title={<span>{itemName}</span>}
        icon={<Icon name="file-text" size={20} />}
        description={item.description}
        meta={
          <MetaText data-testid="resource-source">
            {item.sourceIdentity.scope === 'package'
              ? sourceName
                ? t('row.from', { name: sourceName })
                : t('row.from-plugin')
              : item.sourceIdentity.scope === 'runtime'
                ? t('row.plugin-managed')
                : t(`row.mine.${item.sourceIdentity.scope}`)}
          </MetaText>
        }
        status={
          item.lastSafeError ? (
            <Tag tone="bad" title={resourceFailureLabel(item.lastSafeError.code, t)}>
              {t('skills.readFailed')}
            </Tag>
          ) : undefined
        }
        onOpen={() => onOpen(item)}
        actions={
          <>
            <StateSwitch
              label={t(enabled ? 'row.disable' : 'row.enable', { name: itemName })}
              checked={enabled}
              busy={busy}
              disabled={switchDisabled || item.sourceIdentity.scope === 'runtime'}
              onToggle={(next) => onToggleDesired(item, next)}
            />
            <Menu
              label={t('skills.actions')}
              trigger={<IconButton name="ellipsis" label={t('skills.actions')} />}
              items={[
                ...(runnerAvailable && enabled
                  ? [
                      {
                        id: 'run',
                        testId: 'skill-run',
                        label: t('skills.run'),
                        onSelect: () => skillRunner?.(item.name),
                      },
                    ]
                  : []),
                { id: 'details', label: t('skills.details'), onSelect: () => onOpen(item) },
                ...(menuItems ?? menuOf?.(item) ?? []),
              ]}
            />
          </>
        }
      />
    )
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
          <Button
            htmlType="button"
            className="plugin-details-button"
            aria-pressed={selected}
            aria-label={t('row.open-aria', { name: itemName })}
            onClick={() => onOpen(item)}
          >
            {itemName}
          </Button>
        </h2>
        <p>{`${item.serverId} · ${item.transportKind.toUpperCase()}`}</p>
        <p className="plugin-source">{`${t('row.secret', { kind: item.secretBindingKind })} · ${item.definition.toolPolicy?.allow?.length ? t('row.tools-allowed', { count: item.definition.toolPolicy.allow.length }) : t('row.tools-unrestricted')}`}</p>
        {item.lastSafeError && (
          <SettingsState tone="error" className="resource-safe-error">
            {t('row.safe-error', {
              code: item.lastSafeError.code,
              message: resourceFailureLabel(item.lastSafeError.code, t),
            })}
          </SettingsState>
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

/** Unchanged skill descriptors keep their row and menu while another skill settles. */
export const ResourceRow = memo(ResourceRowContent)

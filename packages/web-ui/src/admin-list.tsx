import type { PackageCatalogDescriptor, PackageInstalledDescriptor, PackageSource } from '@agnes/protocol'
import type { JSX } from 'react'
import { contributionText, type RuntimeStateView, runtimeStateLabel, sourceLabel } from './admin-text.js'
import { StateLights, StateSwitch, type StateTone } from './ui/state-lights.js'

export type AdminTab = 'installed' | 'discover'

export type SurfaceLinkItem = Readonly<{
  packageId: string
  surfaceId: string
  mount: string
}>

/** 行内主动作。label/disabled 由壳按权限与忙碌态推导，run 是壳的确认流程入口。 */
export type RowAction = Readonly<{
  label: string
  disabled: boolean
  run: () => Promise<void> | void
}>

function SurfaceLinks({
  links,
  packageId,
}: {
  links: readonly SurfaceLinkItem[]
  packageId: string
}): JSX.Element | undefined {
  if (!links.length) return undefined
  return (
    <div className="plugin-surface-links">
      {links.map((surface) => (
        <a
          key={surface.surfaceId}
          className="secondary-button compact plugin-surface-link"
          href={surface.mount}
          target="_blank"
          rel="noopener"
          onClick={(event) => event.stopPropagation()}
          aria-label={`打开 ${packageId} 的 ${surface.surfaceId} 页面 ${surface.mount}`}
        >
          {links.length === 1 ? `打开页面 · ${surface.mount}` : `${surface.surfaceId} · ${surface.mount}`}
        </a>
      ))}
    </div>
  )
}

export type OrphanPinItem = Readonly<{
  pinId: string
  packageId: string
  version: string
  purpose: string
  snapshotId: string
}>

/** 孤儿运行时 pin 区：逐条释放或一键全释放，逐条错误就地显示。整块替换骨架 section 的子节点。 */
export function OrphanPins({
  pins,
  errors,
  notice,
  fetchError,
  canRelease,
  onRelease,
}: {
  pins: readonly OrphanPinItem[]
  errors: ReadonlyMap<string, string>
  notice: string | undefined
  fetchError: string | undefined
  canRelease: boolean
  onRelease(pinIds: readonly string[], trigger: HTMLElement): void
}): JSX.Element {
  return (
    <>
      <div className="orphan-pins-heading">
        <strong>存在未释放的孤儿运行时 pin</strong>
        <button
          type="button"
          id="orphan-pins-release-all"
          className="secondary-button compact"
          disabled={!canRelease || pins.length === 0}
          onClick={(event) =>
            onRelease(
              pins.map((pin) => pin.pinId),
              event.currentTarget,
            )
          }
        >
          全部释放
        </button>
      </div>
      <p id="orphan-pins-status" className="orphan-pins-status" hidden={!fetchError && !notice}>
        {fetchError ?? notice ?? ''}
      </p>
      <ul id="orphan-pins-list" className="orphan-pins-list">
        {pins.map((pin) => (
          <li key={pin.pinId} className="orphan-pin-row" data-pin-id={pin.pinId}>
            <div className="orphan-pin-content">
              <p>
                {pin.packageId}@{pin.version} · {pin.purpose}
              </p>
              <p className="orphan-pin-meta">
                pin {pin.pinId} · 快照 {pin.snapshotId}
              </p>
              {errors.get(pin.pinId) && <p className="orphan-pin-error">{errors.get(pin.pinId)}</p>}
            </div>
            <button
              type="button"
              className="secondary-button compact"
              disabled={!canRelease}
              onClick={(event) => onRelease([pin.pinId], event.currentTarget)}
            >
              释放
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/** 四颗状态灯（信任 / 期望 / 实际 / 浏览器 UI）；目录页只有一颗兼容灯。 */
function RowStates({
  tab,
  item,
  runtime,
}: {
  tab: AdminTab
  item: PackageInstalledDescriptor | PackageCatalogDescriptor
  runtime: RuntimeStateView | undefined
}): JSX.Element {
  if (tab === 'installed') {
    const installed = item as PackageInstalledDescriptor
    const actualTone: Record<PackageInstalledDescriptor['actual'], StateTone> = {
      'not-running': 'off',
      starting: 'warn',
      running: 'ok',
      failed: 'bad',
      'restart-required': 'warn',
      unavailable: 'bad',
    }
    const runtimeTone: Record<RuntimeStateView['phase'], StateTone> = {
      idle: 'off',
      loading: 'warn',
      active: 'ok',
      stopping: 'warn',
      failed: 'bad',
    }
    const actualLabels: Record<PackageInstalledDescriptor['actual'], string> = {
      'not-running': '未运行',
      starting: '正在启动',
      running: '运行中',
      failed: '运行失败',
      'restart-required': '需要重启',
      unavailable: '不可用',
    }
    return (
      <StateLights
        states={[
          {
            label: '信任',
            value: installed.trusted ? '已信任' : '未信任',
            tone: installed.trusted ? 'ok' : 'warn',
          },
          {
            label: '期望',
            value: installed.desired === 'enabled' ? '启用' : '停用',
            tone: installed.desired === 'enabled' ? 'ok' : 'off',
          },
          {
            label: '实际',
            value: actualLabels[installed.actual],
            tone: actualTone[installed.actual],
          },
          {
            label: '浏览器 UI',
            value: runtimeStateLabel(runtime),
            tone: runtime ? runtimeTone[runtime.phase] : 'off',
          },
        ]}
      />
    )
  }
  const catalog = item as PackageCatalogDescriptor
  return (
    <StateLights
      states={[
        {
          label: '兼容',
          value: catalog.compatibility === 'unsupported' ? '不支持' : '兼容',
          tone: catalog.compatibility === 'unsupported' ? 'bad' : 'ok',
        },
      ]}
    />
  )
}

function RowControl({
  tab,
  item,
  runtime,
  primaryAction,
  switchDisabled,
  onToggleDesired,
}: {
  tab: AdminTab
  item: PackageInstalledDescriptor | PackageCatalogDescriptor
  runtime: RuntimeStateView | undefined
  primaryAction: RowAction
  switchDisabled: boolean
  onToggleDesired(item: PackageInstalledDescriptor, next: boolean): void
}): JSX.Element {
  const actionButton = (extraClass?: string): JSX.Element => (
    <button
      type="button"
      className={`secondary-button compact${extraClass ? ` ${extraClass}` : ''}`}
      disabled={primaryAction.disabled}
      onClick={(event) => {
        event.stopPropagation()
        void primaryAction.run()
      }}
    >
      {primaryAction.label}
    </button>
  )
  if (tab === 'installed') {
    const installed = item as PackageInstalledDescriptor
    if (!installed.trusted) return actionButton('plugin-row-trust')
    const enabled = installed.desired === 'enabled'
    if (runtime?.phase === 'failed') {
      return (
        <div className="plugin-row-actions">
          <StateSwitch
            label={enabled ? `请求停用 ${installed.id}` : `请求启用 ${installed.id}`}
            checked={enabled}
            disabled={switchDisabled}
            onToggle={(next) => onToggleDesired(installed, next)}
          />
          {actionButton('plugin-row-retry')}
        </div>
      )
    }
    return (
      <StateSwitch
        label={enabled ? `请求停用 ${installed.id}` : `请求启用 ${installed.id}`}
        checked={enabled}
        disabled={switchDisabled}
        onToggle={(next) => onToggleDesired(installed, next)}
      />
    )
  }
  return actionButton()
}

export function PluginList({
  tab,
  rows,
  loading,
  inventoryAuthoritative,
  query,
  nextCursor,
  surfaceLinksOf,
  runtimeOf,
  primaryActionOf,
  switchDisabledOf,
  onOpen,
  onToggleDesired,
  onLoadMore,
}: {
  tab: AdminTab
  rows: readonly (PackageInstalledDescriptor | PackageCatalogDescriptor)[]
  loading: boolean
  inventoryAuthoritative: boolean
  query: string
  nextCursor: string | null
  surfaceLinksOf(packageId: string): readonly SurfaceLinkItem[]
  runtimeOf(packageId: string): RuntimeStateView | undefined
  primaryActionOf(item: PackageInstalledDescriptor | PackageCatalogDescriptor): RowAction
  switchDisabledOf(item: PackageInstalledDescriptor): boolean
  onOpen(item: PackageInstalledDescriptor | PackageCatalogDescriptor): void
  onToggleDesired(item: PackageInstalledDescriptor, next: boolean): void
  onLoadMore(): void
}): JSX.Element {
  if (loading && !rows.length) {
    return <p className="plugin-empty">正在读取插件状态…</p>
  }
  if (!rows.length) {
    const title =
      tab === 'installed'
        ? inventoryAuthoritative
          ? '尚未安装插件'
          : '已安装状态暂不可确认'
        : query
          ? '没有匹配的目录条目'
          : '目录暂时没有可显示的插件'
    const copy =
      tab === 'installed'
        ? inventoryAuthoritative
          ? '可以浏览目录，或从已知来源检查一个插件。'
          : '后台尚未确认当前已安装状态；恢复后会自动刷新。'
        : '请调整搜索词，或确认目录连接后重试。'
    return (
      <div className="plugin-empty admin-empty-state">
        <span className="agnes-mark admin-empty-state-mark" aria-hidden="true" />
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    )
  }
  return (
    <>
      {tab === 'installed' && !inventoryAuthoritative && (
        <p className="plugin-inventory-status">以下为上次读取的状态，当前后台尚未确认。</p>
      )}
      {rows.map((item) => (
        <article
          key={item.id}
          className="plugin-row"
          data-plugin-id={item.id}
          // 目录页第三列是动作按钮、已装页是 Switch，两者宽度不同，用 data-tab 分轨道。
          data-tab={tab}
          tabIndex={0}
          role="button"
          aria-label={`查看 ${item.id} 的详情`}
          onClick={(event) => {
            // 行内 Switch / 动作按钮自己处理点击；置灰控件在部分浏览器里不发 click，
            // 事件会落到行上，所以这里再挡一次，避免「拨开关顺带打开详情」。
            if (event.target instanceof Element && event.target.closest('.switch, button, a')) return
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
            <h2>{item.id}</h2>
            <p>{contributionText(item)}</p>
            <p className="plugin-source">
              {item.version} · {sourceLabel(item.source as PackageSource)}
            </p>
            {tab === 'installed' && <SurfaceLinks links={surfaceLinksOf(item.id)} packageId={item.id} />}
          </div>
          <RowStates tab={tab} item={item} runtime={runtimeOf(item.id)} />
          <RowControl
            tab={tab}
            item={item}
            runtime={runtimeOf(item.id)}
            primaryAction={primaryActionOf(item)}
            switchDisabled={tab === 'installed' ? switchDisabledOf(item as PackageInstalledDescriptor) : true}
            onToggleDesired={onToggleDesired}
          />
        </article>
      ))}
      {tab === 'discover' && nextCursor && (
        <button type="button" className="secondary-button plugin-more" onClick={onLoadMore}>
          加载更多目录条目
        </button>
      )}
    </>
  )
}

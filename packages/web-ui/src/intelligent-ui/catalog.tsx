import { validateAgainst } from '@agnes/protocol'
import type {
  JsonValue,
  UiAction,
  UiArtifactFileData,
  UiComponent,
  UiRowContext,
  UiSourceStatus,
  UiSurface,
} from '@agnes/protocol/gen/intelligent-ui'
import { UiArtifactFileData as ArtifactFileSchema } from '@agnes/protocol/gen/intelligent-ui'
import { Component, type ReactNode, useCallback, useId } from 'react'
import { SettingsState } from '../settings-layout.js'
import { Button } from '../ui/button.js'
import { IconButton } from '../ui/icon-button.js'
import { Table } from '../ui/table.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentChart } from './chart.js'
import { CustomUiComponent, type CustomUiRenderer } from './custom.js'
import { SurfaceFormFields } from './form-fields.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import {
  DetailCard,
  formatFieldValue,
  ImageView,
  PresetStatus,
  PresetTabs,
  ProgressView,
  StepsView,
} from './presets.js'
import {
  actionNeedsDegradedData,
  componentSourceCode,
  componentSourceState,
  degradedDataKeys,
  displayableIntelligentSurface,
  sourceBacked,
} from './source-state.js'
import { columnLabel, surfaceTitle, uiInstant, useNow } from './summary.js'
import { uiObject } from './validate.js'

export interface IntelligentCatalogProps {
  renderArtifact?(file: UiArtifactFileData, componentId: string): ReactNode
  renderCustom?: CustomUiRenderer
  surface: UiSurface
  sources?: Readonly<Record<string, UiSourceStatus>>
  instance?: string
  input: Record<string, JsonValue>
  selection: Record<string, string[]>
  disabled: boolean
  invalid?: boolean
  onInput(componentId: string, value: unknown): void
  onSelection(componentId: string, ids: string[]): void
  onInvalid(componentId: string, path: string, invalid: boolean): void
  onAction(action: UiAction, row?: UiRowContext): void
  onRefreshSource?(): void
  /** Components the surrounding frame shows itself, such as the action bar lifted into its footer. */
  liftedIds?: ReadonlySet<string>
}

export function IntelligentCatalog(props: IntelligentCatalogProps) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  if (!displayableIntelligentSurface(props.surface, props.sources))
    return (
      <SettingsState tone="error" role="alert" data-testid="ui-unavailable">
        {t('ui.unavailable')}
      </SettingsState>
    )
  const placed = placedComponentIds(props.surface)
  const degradedKeys = degradedDataKeys(props.surface, props.sources)
  return (
    <div className="agnes-intelligent-catalog" data-agnes-intelligent-ui="catalog">
      {props.surface.components.map((component) =>
        placed.has(component.id) || props.liftedIds?.has(component.id) ? null : (
          <ComponentBoundary key={`${component.id}:${props.surface.revision}`} fallback={<ComponentFailed />}>
            <CatalogComponent {...props} component={component} degradedKeys={degradedKeys} />
          </ComponentBoundary>
        ),
      )}
    </div>
  )
}

/** One failing preset must not unmount the conversation or keep a persisted session from opening. */
export class ComponentBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function ComponentFailed() {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return (
    <SettingsState tone="error" role="alert" data-testid="ui-component-failed">
      {t('ui.componentFailed')}
    </SettingsState>
  )
}

function placedComponentIds(surface: UiSurface): Set<string> {
  const placed = new Set<string>()
  for (const component of surface.components) {
    if ('fallback' in component || component.kind !== 'tabs') continue
    for (const tab of component.tabs) for (const id of tab.componentIds) placed.add(id)
  }
  return placed
}

function CatalogComponent(
  props: IntelligentCatalogProps & { component: UiComponent; degradedKeys: ReadonlySet<string> },
) {
  const { component, surface, disabled } = props
  const { t, locale } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const now = useNow()
  const instance = useId()
  const reportInvalid = useCallback(
    (path: string, invalid: boolean) => props.onInvalid(component.id, path, invalid),
    [props.onInvalid, component.id],
  )
  const actionButtons = (ids: string[], row?: UiRowContext): ReactNode => (
    <IntelligentActionButtons
      surface={surface}
      actionIds={ids}
      degradedKeys={props.degradedKeys}
      disabled={disabled || props.invalid === true}
      onAction={(action) => props.onAction(action, row)}
    />
  )
  const dataKey = 'dataKey' in component ? component.dataKey : undefined
  const sourceStatus = dataKey ? props.sources?.[dataKey] : undefined
  const sourceData = dataKey ? surface.data[dataKey] : undefined
  const sourceState = componentSourceState(component, sourceData, sourceStatus)
  const sourceCode = componentSourceCode(component, sourceData, sourceStatus)
  const onRefreshSource = props.onRefreshSource
  const refreshable = !!dataKey && !!onRefreshSource && sourceBacked(sourceData, sourceStatus)
  let content: ReactNode = null
  if (dataKey && sourceState !== 'ready')
    content = <SourceNotice state={sourceState} {...(sourceCode ? { code: sourceCode } : {})} />
  else if ('fallback' in component) {
    content = (
      <CustomUiComponent
        component={component}
        surface={surface}
        disabled={disabled || props.invalid === true}
        {...(props.renderCustom ? { render: props.renderCustom } : {})}
        onAction={(id) => {
          const action = surface.actions.find((item) => item.id === id)
          if (
            !disabled &&
            !props.invalid &&
            component.actionIds.includes(id) &&
            action &&
            !actionNeedsDegradedData(action, surface, props.degradedKeys)
          )
            props.onAction(action)
        }}
      />
    )
  } else if (component.kind === 'form')
    content = (
      <>
        <fieldset
          className="agnes-intelligent-form"
          disabled={disabled}
          data-testid={`ui-form-${component.id}`}
        >
          <SurfaceFormFields
            root={component.schema}
            schema={component.schema}
            value={
              Object.hasOwn(props.input, component.id)
                ? props.input[component.id]
                : surface.data[component.dataKey]
            }
            path={`/${surface.id}/${component.id}/${props.instance ?? instance}`}
            issues={[]}
            disabled={disabled}
            onChange={(value) => props.onInput(component.id, value)}
            onInvalid={reportInvalid}
          />
        </fieldset>
        {actionButtons(component.actionIds ?? [])}
      </>
    )
  else if (component.kind === 'button-group') content = actionButtons(component.actionIds)
  else if (component.kind === 'chart')
    content = <IntelligentChart component={component} data={surface.data[component.dataKey]!} />
  else if (component.kind === 'text')
    content = <p className="agnes-intelligent-text">{String(surface.data[component.dataKey])}</p>
  else if (component.kind === 'status')
    content = (
      <p className="agnes-intelligent-status">
        <PresetStatus value={String(surface.data[component.dataKey])} />
      </p>
    )
  else if (component.kind === 'artifact-file') {
    const parsed = validateAgainst<UiArtifactFileData>(ArtifactFileSchema, surface.data[component.dataKey])
    content = parsed.ok ? (
      (props.renderArtifact?.(parsed.value, component.id) ?? (
        <p>
          {parsed.value.name} — {parsed.value.description}
        </p>
      ))
    ) : (
      <ComponentFailed />
    )
  } else if (component.kind === 'detail-card')
    content = (
      <DetailCard
        id={component.id}
        fields={component.fields}
        data={surface.data[component.dataKey]}
        {...(component.statusKey ? { statusKey: component.statusKey } : {})}
        {...(component.secondaryKey ? { secondaryKey: component.secondaryKey } : {})}
      />
    )
  else if (component.kind === 'steps')
    content = <StepsView id={component.id} data={surface.data[component.dataKey]} />
  else if (component.kind === 'progress')
    content = <ProgressView id={component.id} data={surface.data[component.dataKey]} />
  else if (component.kind === 'image')
    content = <ImageView id={component.id} alt={component.alt} data={surface.data[component.dataKey]} />
  else if (component.kind === 'tabs')
    content = (
      <PresetTabs
        id={component.id}
        tabs={component.tabs}
        label={t('ui.sections')}
        renderChild={(id) => {
          const child = surface.components.find((item) => item.id === id)
          if (!child || (!('fallback' in child) && child.kind === 'tabs')) return null
          return <CatalogComponent {...props} component={child} />
        }}
      />
    )
  else if (component.kind === 'table') {
    const data = surface.data[component.dataKey]
    const rows = Array.isArray(data) ? data.filter(uiObject) : []
    const selection = props.selection[component.id] ?? []
    const numericKeys = new Set(
      component.columns
        .filter(
          (column) =>
            column.format === 'number' ||
            column.format === 'currency' ||
            (rows.length > 0 && rows.every((row) => typeof row[column.key] === 'number')),
        )
        .map((column) => column.key),
    )
    const format = (value: JsonValue | undefined, kind?: string): string =>
      formatFieldValue(value, kind, locale)
    content = (
      <Table<Record<string, JsonValue>>
        // The visible title is the block heading above the table; the caption only names it.
        caption={component.title ?? surfaceTitle(surface, t)}
        captionRepeatsHeading
        testId={`ui-table-${component.id}`}
        dataSource={rows}
        rowKey={(row) => String(row[component.rowKey])}
        empty={<p role="status">{t('ui.tableEmpty')}</p>}
        {...(component.selection === 'none'
          ? {}
          : {
              rowSelection: {
                type: component.selection === 'single' ? 'radio' : 'checkbox',
                columnTitle: t('ui.select', { row: '' }),
                columnWidth: 80,
                hideSelectAll: true,
                preserveSelectedRowKeys: true,
                selectedRowKeys: selection,
                getCheckboxProps: (row) => ({
                  name: `${instance}-${component.id}`,
                  disabled,
                  'aria-label': t('ui.select', { row: String(row[component.rowKey]) }),
                  'data-testid': `ui-select-${component.id}-${String(row[component.rowKey])}`,
                }),
                onChange: (keys) => props.onSelection(component.id, keys.map(String)),
              },
            })}
        columns={[
          ...component.columns.map((column, i) => ({
            key: column.key,
            dataIndex: column.key,
            title: columnLabel(column.label, t),
            ...(i === 0 ? { rowScope: 'row' as const } : {}),
            onCell: () => ({
              scope: i === 0 ? 'row' : undefined,
              'data-numeric': numericKeys.has(column.key) || undefined,
            }),
            onHeaderCell: () => ({ scope: 'col', 'data-numeric': numericKeys.has(column.key) || undefined }),
            sorter: (a: Record<string, JsonValue>, b: Record<string, JsonValue>) => {
              const av = a[column.key],
                bv = b[column.key]
              return typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : format(av, column.format).localeCompare(format(bv, column.format), locale, {
                    numeric: true,
                  })
            },
            render: (value: JsonValue | undefined) => {
              const text = format(value, column.format)
              const instant = column.format === 'date' ? uiInstant(value, locale, now) : undefined
              return instant ? (
                <time className="agnes-intelligent-cell" dateTime={instant.iso} title={instant.iso}>
                  {t('ui.instant', { time: instant.time, relative: instant.relative })}
                </time>
              ) : column.format === 'status' && text ? (
                <PresetStatus value={text} />
              ) : (
                text
              )
            },
          })),
          ...(component.rowActionIds?.length
            ? [
                {
                  key: 'actions',
                  title: t('ui.actions'),
                  ellipsis: false,
                  render: (_value: unknown, row: Record<string, JsonValue>) =>
                    actionButtons(component.rowActionIds ?? [], {
                      tableId: component.id,
                      rowId: String(row[component.rowKey]),
                    }),
                },
              ]
            : []),
        ]}
      />
    )
  }
  return (
    <section
      className="agnes-intelligent-component"
      data-kind={component.kind}
      data-testid={`ui-component-${component.id}`}
      aria-label={component.title ?? component.id}
    >
      {component.title || (onRefreshSource && refreshable) ? (
        <header className="agnes-intelligent-component-head">
          {component.title ? <h4>{component.title}</h4> : null}
          {onRefreshSource && refreshable ? (
            <IconButton
              name="refresh-cw"
              className="agnes-intelligent-refresh"
              data-testid="ui-source-refresh"
              disabled={disabled || props.invalid === true}
              label={`${t('ui.refresh')} ${component.title ?? component.id}`}
              onClick={onRefreshSource}
            />
          ) : null}
        </header>
      ) : null}
      {content}
    </section>
  )
}

/** The buttons for a set of the surface's actions; one that needs unavailable data stays disabled. */
export function IntelligentActionButtons(props: {
  surface: UiSurface
  actionIds: readonly string[]
  degradedKeys: ReadonlySet<string>
  disabled: boolean
  onAction(action: UiAction): void
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return (
    <div className="agnes-intelligent-actions" role="group" aria-label={t('ui.actions')}>
      {props.actionIds.map((id) => {
        const action = props.surface.actions.find((item) => item.id === id)!
        return (
          <Button
            key={id}
            htmlType="button"
            type={action.style === 'primary' ? 'primary' : 'default'}
            danger={action.style === 'danger'}
            disabled={props.disabled || actionNeedsDegradedData(action, props.surface, props.degradedKeys)}
            data-testid={`ui-action-${id}`}
            onClick={() => props.onAction(action)}
          >
            {action.label}
          </Button>
        )
      })}
    </div>
  )
}

function SourceNotice(props: { state: 'loading' | 'error'; code?: string }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  if (props.state === 'loading')
    return (
      <SettingsState
        tone="loading"
        className="agnes-intelligent-source-state"
        data-testid="ui-source-loading"
        aria-busy="true"
      >
        {t('ui.sourceLoading')}
      </SettingsState>
    )
  return (
    <SettingsState tone="error" className="agnes-intelligent-source-state" data-testid="ui-source-error">
      <p>{props.code === 'UI_SOURCE_SHAPE' ? t('ui.sourceShape') : t('ui.sourceError')}</p>
      {props.code ? <p>{props.code}</p> : null}
    </SettingsState>
  )
}

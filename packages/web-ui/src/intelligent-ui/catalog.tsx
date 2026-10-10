import type {
  JsonValue,
  UiAction,
  UiComponent,
  UiRowContext,
  UiSourceStatus,
  UiSurface,
} from '@agnes/protocol/gen/intelligent-ui'
import { type ReactNode, useCallback, useId } from 'react'
import { SettingsState } from '../settings-layout.js'
import { Button } from '../ui/button.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentChart } from './chart.js'
import { CustomUiComponent, type CustomUiRenderer } from './custom.js'
import { SurfaceFormFields } from './form-fields.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { DetailCard, formatFieldValue, ImageView, PresetTabs, ProgressView, StepsView } from './presets.js'
import {
  actionNeedsDegradedData,
  componentSourceCode,
  componentSourceState,
  degradedDataKeys,
  displayableIntelligentSurface,
  sourceBacked,
} from './source-state.js'
import { uiObject } from './validate.js'

export interface IntelligentCatalogProps {
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
        placed.has(component.id) ? null : (
          <CatalogComponent
            key={`${component.id}:${props.surface.revision}`}
            {...props}
            component={component}
            degradedKeys={degradedKeys}
          />
        ),
      )}
    </div>
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
  const instance = useId()
  const reportInvalid = useCallback(
    (path: string, invalid: boolean) => props.onInvalid(component.id, path, invalid),
    [props.onInvalid, component.id],
  )
  const actionButtons = (ids: string[], row?: UiRowContext): ReactNode => (
    <div role="group" aria-label={t('ui.actions')}>
      {ids.map((id) => {
        const action = surface.actions.find((item) => item.id === id)!
        return (
          <Button
            key={id}
            htmlType="button"
            type={action.style === 'primary' ? 'primary' : 'default'}
            danger={action.style === 'danger'}
            disabled={
              disabled ||
              props.invalid === true ||
              actionNeedsDegradedData(action, surface, props.degradedKeys)
            }
            data-testid={`ui-action-${id}`}
            onClick={() => props.onAction(action, row)}
          >
            {action.label}
          </Button>
        )
      })}
    </div>
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
        <fieldset disabled={disabled} data-testid={`ui-form-${component.id}`}>
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
  else if (component.kind === 'text' || component.kind === 'status')
    content = <p>{String(surface.data[component.dataKey])}</p>
  else if (component.kind === 'detail-card')
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
    const format = (value: JsonValue | undefined, kind?: string): string =>
      formatFieldValue(value, kind, locale)
    content = (
      <div
        className="agnes-intelligent-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the wide table scrolls on its own axis.
        tabIndex={0}
        role="region"
        aria-label={component.title ?? surface.title}
      >
        <table data-testid={`ui-table-${component.id}`}>
          <caption>{component.title ?? surface.title}</caption>
          <thead>
            <tr>
              {component.selection !== 'none' && <th scope="col">{t('ui.select', { row: '' })}</th>}
              {component.columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
              {component.rowActionIds?.length ? <th scope="col">{t('ui.actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowId = String(row[component.rowKey])
              return (
                <tr key={rowId}>
                  {component.selection !== 'none' && (
                    <td>
                      <input
                        type={component.selection === 'single' ? 'radio' : 'checkbox'}
                        name={`${instance}-${component.id}`}
                        aria-label={t('ui.select', { row: rowId })}
                        data-testid={`ui-select-${component.id}-${rowId}`}
                        disabled={disabled}
                        checked={selection.includes(rowId)}
                        onChange={(event) =>
                          props.onSelection(
                            component.id,
                            component.selection === 'single'
                              ? [rowId]
                              : event.currentTarget.checked
                                ? [...selection, rowId]
                                : selection.filter((id) => id !== rowId),
                          )
                        }
                      />
                    </td>
                  )}
                  {component.columns.map((column, i) =>
                    i === 0 ? (
                      <th key={column.key} scope="row">
                        {format(row[column.key], column.format)}
                      </th>
                    ) : (
                      <td key={column.key}>{format(row[column.key], column.format)}</td>
                    ),
                  )}
                  {component.rowActionIds?.length ? (
                    <td>{actionButtons(component.rowActionIds, { tableId: component.id, rowId })}</td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <section data-testid={`ui-component-${component.id}`} aria-label={component.title ?? component.id}>
      {component.title && (sourceState !== 'ready' || component.kind !== 'table') && (
        <h4>{component.title}</h4>
      )}
      {content}
      {onRefreshSource && refreshable ? (
        <Button
          htmlType="button"
          data-testid="ui-source-refresh"
          disabled={disabled || props.invalid === true}
          aria-label={`${t('ui.refresh')} ${component.title ?? component.id}`}
          onClick={onRefreshSource}
        >
          {t('ui.refresh')}
        </Button>
      ) : null}
    </section>
  )
}

function SourceNotice(props: { state: 'loading' | 'error'; code?: string }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  if (props.state === 'loading')
    return (
      <SettingsState
        tone="loading"
        className="agnes-ui-source-state"
        data-testid="ui-source-loading"
        aria-busy="true"
      >
        {t('ui.sourceLoading')}
      </SettingsState>
    )
  return (
    <SettingsState tone="error" className="agnes-ui-source-state" data-testid="ui-source-error">
      <p>{props.code === 'UI_SOURCE_SHAPE' ? t('ui.sourceShape') : t('ui.sourceError')}</p>
      {props.code ? <p>{props.code}</p> : null}
    </SettingsState>
  )
}

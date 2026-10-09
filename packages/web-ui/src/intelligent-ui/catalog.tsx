import type {
  JsonValue,
  UiAction,
  UiComponent,
  UiRowContext,
  UiSurface,
} from '@agnes/protocol/gen/intelligent-ui'
import { type ReactNode, useCallback, useId } from 'react'
import { SurfaceFormFields } from './form-fields.js'
import { Button } from '../ui/button.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentChart } from './chart.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { uiObject, validIntelligentSurface } from './validate.js'

export interface IntelligentCatalogProps {
  surface: UiSurface
  instance?: string
  input: Record<string, JsonValue>
  selection: Record<string, string[]>
  disabled: boolean
  invalid?: boolean
  onInput(componentId: string, value: unknown): void
  onSelection(componentId: string, ids: string[]): void
  onInvalid(componentId: string, path: string, invalid: boolean): void
  onAction(action: UiAction, row?: UiRowContext): void
}

export function IntelligentCatalog(props: IntelligentCatalogProps) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  if (!validIntelligentSurface(props.surface))
    return (
      <p role="alert" data-testid="ui-unavailable">
        {t('ui.unavailable')}
      </p>
    )
  return (
    <div className="agnes-intelligent-catalog" data-agnes-intelligent-ui="catalog">
      {props.surface.components.map((component) => (
        <CatalogComponent
          key={`${component.id}:${props.surface.revision}`}
          {...props}
          component={component}
        />
      ))}
    </div>
  )
}

function CatalogComponent(props: IntelligentCatalogProps & { component: UiComponent }) {
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
            disabled={disabled || props.invalid === true}
            data-testid={`ui-action-${id}`}
            onClick={() => props.onAction(action, row)}
          >
            {action.label}
          </Button>
        )
      })}
    </div>
  )
  let content: ReactNode
  if (component.kind === 'form')
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
  else {
    const data = surface.data[component.dataKey]
    const rows = Array.isArray(data) ? data.filter(uiObject) : []
    const selection = props.selection[component.id] ?? []
    const format = (value: JsonValue | undefined, kind?: string): string => {
      // Currency units and date/time zones are never inferred from display-only hints.
      if (kind === 'number' && typeof value === 'number') return new Intl.NumberFormat(locale).format(value)
      return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
    }
    content = (
      <div className="agnes-intelligent-table-scroll">
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
      {component.title && component.kind !== 'table' && <h4>{component.title}</h4>}
      {content}
    </section>
  )
}

import type { PackageOperation } from '@agnes/protocol'
import type { JSX, ReactNode } from 'react'
import { ADMIN_LOCALE_NAMESPACE, operationLabel } from './admin-text.js'
import { adminLocaleCatalog } from './locales/admin.js'
import { ADMIN_DETAIL_LOCALE_NAMESPACE, adminDetailLocaleCatalog } from './locales/admin-detail.js'
import { Button } from './ui/button.js'
import { IconButton } from './ui/icon-button.js'
import { Menu } from './ui/menu.js'
import { useUiText } from './ui-locale.js'

export type DetailActionSpec = Readonly<{
  label: string
  className: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** Render link actions as `<a target="_blank" rel="noopener">`, preserving the `.plugin-surface-link` contract. */
  href?: string
  /** The detail tab this action belongs to; ungrouped actions stay in the footer. */
  group?: 'overview' | 'trust' | 'versions'
  danger?: boolean
  onClick(): void
}>

export type DetailOperationRow = Readonly<{
  operation: PackageOperation
  canCancel: boolean
}>

function BlockersSection({
  title,
  items,
}: {
  title: string
  items: readonly string[]
}): JSX.Element | undefined {
  if (!items.length) return undefined
  return (
    <section className="plugin-blockers">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Detail/action modal body. The host skeleton retains `<dialog>` and manages showModal, Escape
 * and focus restoration. React replaces only its children, so this component has no dialog element.
 */
export function DetailContent({
  heading,
  intro,
  version,
  stateText,
  metadata,
  content,
  facts,
  blockerSections,
  operations,
  lastOperationLabel,
  actions,
  headAction,
  onClose,
  onCancelOperation,
}: {
  /** The main control of the thing shown, e.g. a plugin's on/off switch. */
  headAction?: ReactNode
  heading: string
  intro: string
  version: string | undefined
  content?: ReactNode
  metadata?: ReactNode
  stateText: string | undefined
  facts: readonly (readonly [label: string, value: string])[]
  blockerSections: readonly { title: string; items: readonly string[] }[]
  operations: readonly DetailOperationRow[]
  lastOperationLabel: string | undefined
  actions: readonly DetailActionSpec[]
  onClose(): void
  onCancelOperation(operationId: string, trigger: HTMLButtonElement): void
}): JSX.Element {
  const { t } = useUiText(ADMIN_DETAIL_LOCALE_NAMESPACE, adminDetailLocaleCatalog)
  const { t: adminText } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  return (
    <>
      <div className="admin-detail-head">
        <div className="plugin-detail-heading">
          <h2>{heading}</h2>
          {headAction}
          <IconButton
            name="x"
            className="plugin-detail-close"
            onClick={onClose}
            label={t('close.aria', { heading })}
          />
        </div>
        {version && <p className="plugin-detail-version">{version}</p>}
        {metadata}
        {stateText && <p className="plugin-detail-state">{stateText}</p>}
        <p>{intro}</p>
      </div>
      <div className="admin-detail-scroll">
        {/* What blocks the plugin or is still running comes first; it is why the user is here. */}
        {blockerSections.map((section) => (
          <BlockersSection key={section.title} title={section.title} items={section.items} />
        ))}
        {lastOperationLabel && (
          <section className="plugin-operations">
            <h3>{t('operations.recent')}</h3>
            <p>{lastOperationLabel}</p>
          </section>
        )}
        {operations.length > 0 && (
          <section className="plugin-operations">
            <h3>{t('operations.ongoing')}</h3>
            {operations.map(({ operation, canCancel }) => (
              <div key={operation.operationId} className="operation-row">
                <p>
                  {operationLabel(operation, adminText)}
                  {operation.progress ? ` · ${operation.progress}%` : ''}
                  {operation.retryable ? ` · ${t('operations.retry')}` : ''}
                </p>
                {canCancel && (
                  <Button
                    htmlType="button"
                    size="small"
                    onClick={(event) =>
                      event.currentTarget instanceof HTMLButtonElement &&
                      onCancelOperation(operation.operationId, event.currentTarget)
                    }
                  >
                    {t('operations.cancel')}
                  </Button>
                )}
              </div>
            ))}
          </section>
        )}
        {content}
        {facts.length > 0 && (
          <dl className="plugin-facts">
            {facts.map(([label, value]) => (
              <FragmentedFact key={`${label}:${value}`} label={label} value={value} />
            ))}
          </dl>
        )}
      </div>
      <div className="admin-detail-actions" hidden={actions.length === 0}>
        {actions
          .filter(
            (action) =>
              !action.href &&
              (action.className.includes('--primary') || action.className.includes('primary-button')),
          )
          .map((action) => (
            <Button
              key={action.label}
              appearance="primary"
              className={actionClasses(action.className)}
              title={action.title}
              aria-label={action.ariaLabel}
              disabled={action.disabled ?? false}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        {actions
          .filter((action) => action.href)
          .map((action) => (
            <Button
              key={action.label}
              className={['plugin-surface-link', actionClasses(action.className)].filter(Boolean).join(' ')}
              {...(action.href ? { href: action.href } : {})}
              target="_blank"
              rel="noopener"
              aria-label={action.ariaLabel}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        {actions.filter(
          (action) =>
            !action.href &&
            !(action.className.includes('--primary') || action.className.includes('primary-button')),
        ).length > 0 && (
          <Menu
            label={t('actions')}
            trigger={<Button>{t('actions')}</Button>}
            items={actions
              .filter(
                (action) =>
                  !action.href &&
                  !(action.className.includes('--primary') || action.className.includes('primary-button')),
              )
              .map((action, index) => ({
                id: `detail-${index}`,
                label: action.label,
                className: actionClasses(action.className),
                ...(action.ariaLabel ? { ariaLabel: action.ariaLabel } : {}),
                ...(action.title ? { title: action.title } : {}),
                disabled: action.disabled ?? false,
                ...(action.title ? { disabledReason: action.title } : {}),
                danger: action.className.includes('danger'),
                onSelect: action.onClick,
              }))}
          />
        )}
      </div>
    </>
  )
}

/** Retain caller skin hooks while replacing legacy control classes with primitives. */
function actionClasses(value: string): string {
  const legacy = new Set(['primary-button', 'secondary-button', 'danger-button', 'compact'])
  return value
    .split(/\s+/)
    .filter((name) => !legacy.has(name) && !name.startsWith('agh-btn'))
    .join(' ')
}

function FragmentedFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

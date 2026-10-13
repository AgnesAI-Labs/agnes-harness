import type {
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { createContext, forwardRef, useContext, useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { fallbackT } from './locales/index.js'
import { Button } from './ui/button.js'
import { Disclosure, type DisclosureProps, NestedSurfaceContext } from './ui/disclosure.js'
import { Icon } from './ui/icon.js'
import { IconTile } from './ui/icon-tile.js'
import type { IconName } from './ui/icons.js'
import { Skeleton } from './ui/skeleton.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** The header slots of the page a component is rendered in; nested pages fill them instead of repeating a header. */
type SettingsPageFrame = { lead: HTMLElement | null; actions: HTMLElement | null }
const SettingsPageFrameContext = createContext<SettingsPageFrame | undefined>(undefined)

/**
 * The one settings page template: title, one-line description and page actions in the header,
 * then the body. A page rendered inside another page contributes its description and actions to
 * the outer header, so a screen never shows two titles.
 */
export function SettingsPage({
  title,
  description,
  actions,
  headingId,
  bodyClassName,
  banner,
  toolbar,
  saveBar,
  variant = 'form',
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    headingId?: string
    bodyClassName?: string
    banner?: ReactNode
    toolbar?: ReactNode
    saveBar?: ReactNode
    variant?: 'form' | 'list'
  }) {
  const nested = useContext(SettingsPageFrameContext) !== undefined
  const [lead, setLead] = useState<HTMLElement | null>(null)
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null)
  const frame = useMemo(() => ({ lead, actions: actionsHost }), [lead, actionsHost])
  const body = (
    <>
      {banner}
      {toolbar}
      <div className={['agnes-settings-stack', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      {saveBar}
    </>
  )
  return (
    <section
      {...props}
      data-layout={variant}
      data-nested={nested || undefined}
      className={['agnes-settings-page', props.className].filter(Boolean).join(' ')}
    >
      <SettingsPageHeader
        title={title}
        description={description}
        actions={actions}
        headingId={headingId}
        slots={nested ? undefined : { lead: setLead, actions: setActionsHost }}
      />
      {nested ? (
        body
      ) : (
        <SettingsPageFrameContext.Provider value={frame}>{body}</SettingsPageFrameContext.Provider>
      )}
    </section>
  )
}
/** Page-level actions declared from anywhere inside a page land in that page's header. */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const frame = useContext(SettingsPageFrameContext)
  if (!frame) return <div className="agnes-settings-actions">{children}</div>
  return frame.actions ? createPortal(children, frame.actions) : null
}
/** The page's one-line description, declared by the component that owns the copy. */
export function SettingsPageDescription({ children }: { children: ReactNode }) {
  const frame = useContext(SettingsPageFrameContext)
  if (!frame) return <p className="agnes-settings-page-description">{children}</p>
  return frame.lead ? createPortal(<p>{children}</p>, frame.lead) : null
}
/** A titled part of a page. Its content sits below the heading, never inside a second frame. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title?: ReactNode
    description?: ReactNode
    actions?: ReactNode
  }) {
  return (
    <section {...props} className={['agnes-settings-section', props.className].filter(Boolean).join(' ')}>
      {(title || description || actions) && (
        <div className="agnes-settings-section-heading">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="agnes-settings-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
/** One quiet outline around a run of setting rows. */
export function SettingsGroup({ children, ...props }: HTMLAttributes<HTMLDivElement> & DataAttributes) {
  return (
    <div {...props} className={['agnes-settings-group', props.className].filter(Boolean).join(' ')}>
      <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
    </div>
  )
}
/**
 * A setting row: an optional icon tile, what it is on the left, its control on the right (or
 * below when `stacked`).
 */
export function SettingsItem({
  label,
  description,
  labelId,
  icon,
  stacked = false,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> &
  DataAttributes & {
    label: ReactNode
    description?: ReactNode
    labelId?: string
    icon?: IconName
    stacked?: boolean
  }) {
  return (
    <div
      {...props}
      data-stacked={stacked || undefined}
      className={['agnes-settings-item', props.className].filter(Boolean).join(' ')}
    >
      {icon && <IconTile name={icon} />}
      <div className="agnes-settings-item-copy">
        <div className="agnes-settings-item-label" id={labelId}>
          {label}
        </div>
        {description && <div className="agnes-settings-item-description">{description}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && (
        <div className="agnes-settings-item-control">{children}</div>
      )}
    </div>
  )
}
/** A section whose content is one outlined block; the heading stays outside the outline. */
export function SettingsCard({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title?: ReactNode
    description?: ReactNode
    actions?: ReactNode
  }) {
  // An object card that writes its own content is the outline itself.
  if (!title && !description && !actions)
    return (
      <section
        {...props}
        className={['config-card', 'agnes-settings-card', props.className].filter(Boolean).join(' ')}
      >
        <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
      </section>
    )
  return (
    <SettingsSection {...props} title={title} description={description} actions={actions}>
      <div className="config-card agnes-settings-card">
        <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
      </div>
    </SettingsSection>
  )
}
export function SettingsState({
  tone = 'empty',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: 'empty' | 'loading' | 'error' | 'success' }) {
  return (
    <div
      {...props}
      className={['agnes-settings-state', props.className].filter(Boolean).join(' ')}
      data-tone={tone}
      role={props.role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-live={props['aria-live'] ?? 'polite'}
      aria-busy={props['aria-busy'] ?? (tone === 'loading' || undefined)}
    >
      {tone === 'loading' && <Skeleton />}
      {children}
    </div>
  )
}
export const SettingsInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & DataAttributes & { surface?: 'page' | 'surface' }
>(function SettingsInput({ surface = 'page', ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={[
        'agnes-settings-input',
        surface === 'surface' && 'agnes-settings-input-surface',
        props.className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
})
export const SettingsTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & DataAttributes & { presentation?: 'field' | 'plain' }
>(function SettingsTextArea({ presentation = 'field', ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={[presentation === 'field' ? 'agnes-settings-input' : 'agnes-ui-textarea', props.className]
        .filter(Boolean)
        .join(' ')}
    />
  )
})
/** Native select preserves form semantics, following SettingsOptionSelect's account-dialog pattern. */
export const SettingsSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & DataAttributes
>(function SettingsSelect(props, ref) {
  return (
    <select
      {...props}
      ref={ref}
      className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
    />
  )
})

/** One grouped card of rows: accounts, plugins, servers, schedules. Rows are divided, never boxed again. */
export function SettingsList({ children, ...props }: HTMLAttributes<HTMLDivElement> & DataAttributes) {
  return (
    <div {...props} className={['agnes-settings-list', props.className].filter(Boolean).join(' ')}>
      <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
    </div>
  )
}
export function SettingsRow({
  title,
  description,
  actions,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
  }) {
  return (
    <article {...props} className={['agnes-settings-row', props.className].filter(Boolean).join(' ')}>
      <div className="agnes-settings-row-heading">
        <div>
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="agnes-settings-actions">{actions}</div>}
      </div>
      <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
    </article>
  )
}
/**
 * A collapsible part of a page. `card` makes it a grouped card of its own: icon tile, title, the
 * current value in one line, and the content opening inside the same card.
 */
export function SettingsDetails({
  title,
  children,
  compact = false,
  card,
  icon,
  summary,
  description,
  ...props
}: Omit<
  DisclosureProps,
  'title' | 'summary' | 'variant' | 'summaryProps' | 'icon' | 'meta' | 'description'
> & {
  title: ReactNode
  compact?: boolean
  card?: boolean | undefined
  icon?: IconName | undefined
  /** One muted line under a card's title. */
  description?: ReactNode
  /** The current value in a few words, shown beside the title. */
  summary?: ReactNode
  'data-testid'?: string
}) {
  // On the page a section is a card of its own; inside a card, a list row or another section it
  // is one of that surface's rows.
  const nested = useContext(NestedSurfaceContext)
  return (
    <Disclosure
      {...props}
      summary={title}
      variant={compact ? 'plain' : card || !nested ? 'card' : 'row'}
      icon={icon ? <Icon name={icon} /> : undefined}
      meta={summary}
      description={description}
      data-compact={compact || undefined}
      className={['agnes-settings-details', props.className].filter(Boolean).join(' ')}
      summaryProps={{ 'data-testid': props['data-testid'] ? `${props['data-testid']}-toggle` : undefined }}
    >
      {children}
    </Disclosure>
  )
}
/** Diagnostics a user rarely needs: kept on the page, collapsed, under one fixed name. */
export function SettingsTechnicalDetails({
  title,
  children,
  ...props
}: Omit<DisclosureProps, 'title' | 'summary' | 'variant'> & DataAttributes & { title?: ReactNode }) {
  const nested = useContext(NestedSurfaceContext)
  return (
    <Disclosure
      {...props}
      variant={nested ? 'plain' : 'card'}
      icon={nested ? undefined : <Icon name="code" />}
      summary={title ?? fallbackT('ui.technicalDetails')}
      className={['agnes-settings-technical', props.className].filter(Boolean).join(' ')}
    >
      {children}
    </Disclosure>
  )
}
export function SettingsToolbar({
  search,
  filters,
  controls,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  search?: ReactNode
  filters?: ReactNode
  controls?: ReactNode
}) {
  return (
    <div {...props} className={['agnes-settings-toolbar', props.className].filter(Boolean).join(' ')}>
      {search && <div className="agh-settings-toolbar-search">{search}</div>}
      {filters && <div className="agh-settings-toolbar-filters">{filters}</div>}
      {controls && <div className="agh-settings-toolbar-controls">{controls}</div>}
      {children}
    </div>
  )
}

/** Native checkbox with a shared compact label and field sizing. */
export function SettingsCheckbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="agnes-settings-checkbox">
      <input {...props} type="checkbox" /> <span>{label}</span>
    </label>
  )
}

/** A native choice keeps radio-group keyboard and form semantics in the shared layer. */
export function SettingsChoice({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  type: 'radio' | 'checkbox'
  label: ReactNode
  hint?: ReactNode
}) {
  const generatedId = useId()
  const id = props.id ?? generatedId
  return (
    <label className="appearance-option" htmlFor={id}>
      <SettingsInput {...props} id={id} />
      <span className="appearance-option-copy">
        <span className="appearance-option-name">{label}</span>
        {hint && <span className="appearance-option-hint">{hint}</span>}
      </span>
    </label>
  )
}

/** Read-only code region remains keyboard scrollable when its content overflows. */
export function SettingsCode({ label, ...props }: HTMLAttributes<HTMLPreElement> & { label: string }) {
  return (
    <section aria-label={label}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll long prompt and JSON blocks. */}
      <pre {...props} tabIndex={0} />
    </section>
  )
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  headingId,
  slots,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> &
  DataAttributes & {
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    headingId?: string | undefined
    /** Set by SettingsPage: receives the header's description and actions hosts. */
    slots?: { lead(node: HTMLElement | null): void; actions(node: HTMLElement | null): void } | undefined
  }) {
  const frame = useContext(SettingsPageFrameContext)
  // Inside another page the outer header already names the screen: keep the heading for
  // assistive tech and existing references, and hand the rest to the outer header.
  if (frame && !slots)
    return (
      <>
        <h2 id={headingId} className="visually-hidden">
          {title}
        </h2>
        {description && frame.lead && createPortal(<p>{description}</p>, frame.lead)}
        {actions && frame.actions && createPortal(actions, frame.actions)}
      </>
    )
  return (
    <header
      {...props}
      className={['config-heading', 'agnes-settings-page-heading', props.className].filter(Boolean).join(' ')}
    >
      <div ref={slots?.lead}>
        <h2 id={headingId}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {(actions || slots) && (
        <div className="agnes-settings-actions" ref={slots?.actions}>
          {actions}
        </div>
      )}
    </header>
  )
}
export function SettingsSaveBar({
  dirty,
  busy = false,
  saved = false,
  onDiscard,
  onSave,
  message,
  discardLabel,
  saveLabel,
}: {
  dirty: boolean
  busy?: boolean
  saved?: boolean
  onDiscard(): void
  onSave(): void
  message?: string
  discardLabel?: string
  saveLabel?: string
}) {
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!saved) {
      setShowSaved(false)
      return
    }
    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [saved])
  if (!dirty)
    return showSaved ? (
      <div className="agh-settings-saved" role="status">
        <Icon name="check" />
        {fallbackT('ui.saved')}
      </div>
    ) : null
  return (
    <div
      className="agh-settings-save-bar"
      role="region"
      aria-label={fallbackT('ui.unsaved')}
      aria-busy={busy || undefined}
    >
      <span>{message ?? fallbackT('ui.unsaved')}</span>
      <div className="agnes-settings-actions">
        <Button onClick={onDiscard} disabled={busy} disabledReason={fallbackT('ui.saving')}>
          {discardLabel ?? fallbackT('ui.discard')}
        </Button>
        <Button appearance="primary" onClick={onSave} loading={busy}>
          {saveLabel ?? fallbackT('ui.save')}
        </Button>
      </div>
    </div>
  )
}

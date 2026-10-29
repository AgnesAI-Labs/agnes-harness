import type { HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { createContext, forwardRef, useContext, useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAdvancedSettings } from './advanced-settings.js'
import { fallbackT } from './locales/index.js'
import { SettingsUndoScope } from './settings-autosave.js'
import { Button } from './ui/button.js'
import { CopyButton } from './ui/copy-button.js'
import { Disclosure, type DisclosureProps, NestedSurfaceContext } from './ui/disclosure.js'
import { Icon } from './ui/icon.js'
import type { IconName } from './ui/icon-set.js'
import { IconTile } from './ui/icon-tile.js'
import { LOADABLE_DELAY_MS, LOADABLE_SLOW_MS } from './ui/loadable.js'
import { PushHeader } from './ui/push-stack.js'
import { SettingsInfo, SettingsSubpageFrame } from './ui/settings-subpages.js'
import { Skeleton } from './ui/skeleton.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** The header slots of the page a component is rendered in; nested pages fill them instead of repeating a header. */
type SettingsPageFrame = { actions: HTMLElement | null }
const SettingsPageFrameContext = createContext<SettingsPageFrame | undefined>(undefined)

/**
 * The one settings page template: one header line (the title, which is the breadcrumb's top level,
 * then the page actions beside the dialog's ×) and the body. The description is read to assistive
 * tech only. A page rendered inside another page contributes its actions to the outer header, so a
 * screen never shows two titles.
 */
export function SettingsPage({
  title,
  description,
  actions,
  headingId,
  routeId,
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
    /** Canonical settings page identity; its subpages become URL levels. */
    routeId?: string | undefined
    bodyClassName?: string
    banner?: ReactNode
    toolbar?: ReactNode
    saveBar?: ReactNode
    variant?: 'form' | 'list'
  }) {
  const nested = useContext(SettingsPageFrameContext) !== undefined
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null)
  const frame = useMemo(() => ({ actions: actionsHost }), [actionsHost])
  const body = (
    <>
      {banner}
      {toolbar}
      <div
        className={['agnes-settings-stack', !nested && 'agnes-settings-page-body', bodyClassName]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </div>
      {saveBar}
    </>
  )
  const header = (
    <SettingsPageHeader
      className={nested ? undefined : 'agnes-settings-page-top'}
      title={title}
      description={description}
      actions={actions}
      headingId={headingId}
      slots={nested ? undefined : { actions: setActionsHost }}
    />
  )
  return (
    <section
      {...props}
      data-layout={variant}
      data-nested={nested || undefined}
      className={['agnes-settings-page', props.className].filter(Boolean).join(' ')}
    >
      {nested ? (
        <>
          {header}
          {body}
        </>
      ) : (
        // A top-level page drills into subpages and undoes its last saved change with ⌘Z.
        <SettingsUndoScope>
          <SettingsSubpageFrame header={header} rootTitle={title} routeId={routeId}>
            <SettingsPageFrameContext.Provider value={frame}>{body}</SettingsPageFrameContext.Provider>
          </SettingsSubpageFrame>
        </SettingsUndoScope>
      )}
    </section>
  )
}
/**
 * Lets a host page with its own header receive what the panels inside it declare: their page
 * actions land in `actions`, and their description is dropped because the host already has one.
 */
export function SettingsPageSlots({
  actions,
  children,
}: {
  actions: HTMLElement | null
  children: ReactNode
}) {
  return <SettingsPageFrameContext.Provider value={{ actions }}>{children}</SettingsPageFrameContext.Provider>
}
/** Page-level actions declared from anywhere inside a page land in that page's header. */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const frame = useContext(SettingsPageFrameContext)
  if (!frame) return <div className="agnes-settings-actions">{children}</div>
  return frame.actions ? createPortal(children, frame.actions) : null
}
/** A page description outside a settings page; inside one the header line shows no description. */
export function SettingsPageDescription({ children }: { children: ReactNode }) {
  const frame = useContext(SettingsPageFrameContext)
  if (!frame) return <p className="agnes-settings-page-description">{children}</p>
  // Inside a page the header line is the title alone; a description adds no second line.
  return null
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
  info,
  labelId,
  icon,
  leading,
  stacked = false,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> &
  DataAttributes & {
    label: ReactNode
    description?: ReactNode
    /** The longer explanation, behind an ⓘ beside the name. */
    info?: string | undefined
    labelId?: string
    icon?: IconName
    /** Before the icon: a drag handle or a logo tile. */
    leading?: ReactNode
    stacked?: boolean
  }) {
  return (
    <div
      {...props}
      data-stacked={stacked || undefined}
      className={['agnes-settings-item', props.className].filter(Boolean).join(' ')}
    >
      {leading}
      {icon && <IconTile name={icon} />}
      <div className="agnes-settings-item-copy">
        <div className="agnes-settings-item-label" id={labelId}>
          {label}
          {info && <SettingsInfo text={info} />}
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
      {tone === 'loading' ? <LoadingState>{children}</LoadingState> : children}
    </div>
  )
}

/**
 * A read in progress, the shared way: nothing for 200 ms, then quiet grey lines,
 * and 「Still reading…」 only after 3 s. What is being read is announced, not printed on its own line.
 */
function LoadingState({ children }: { children?: ReactNode }) {
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'slow'>('hidden')
  useEffect(() => {
    const show = setTimeout(() => setPhase('shown'), LOADABLE_DELAY_MS)
    const slow = setTimeout(() => setPhase('slow'), LOADABLE_SLOW_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(slow)
    }
  }, [])
  return (
    <>
      {phase !== 'hidden' && <Skeleton />}
      <span className="agh-visually-hidden">{children}</span>
      {phase === 'slow' && <span className="agnes-settings-state-slow">{fallbackT('ui.stillLoading')}</span>}
    </>
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
export { SettingsSelect } from './ui/settings-select.js'

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
/**
 * A setting only a few people change. It exists on the page only while 「Show advanced settings」 is on; then it
 * is a dashed card marked "Advanced" whose header states the current value.
 */
export function SettingsAdvanced({
  title,
  summary,
  children,
  ...props
}: Omit<DisclosureProps, 'title' | 'summary' | 'variant' | 'summaryProps' | 'icon' | 'meta'> & {
  title: ReactNode
  /** The current value in a few words, shown while the fold is closed. */
  summary?: ReactNode
  'data-testid'?: string
}) {
  const shown = useAdvancedSettings()
  if (!shown) return null
  return (
    <Disclosure
      {...props}
      variant="card"
      summary={
        <>
          {title}
          <span className="agh-advanced-mark">{fallbackT('ui.advanced')}</span>
        </>
      }
      meta={summary}
      className={['agnes-settings-details', 'agnes-settings-advanced', props.className]
        .filter(Boolean)
        .join(' ')}
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
  preview,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  type: 'radio' | 'checkbox'
  label: ReactNode
  hint?: ReactNode
  /** A small picture of the choice, shown above its name. */
  preview?: ReactNode
}) {
  const generatedId = useId()
  const id = props.id ?? generatedId
  return (
    <label className="appearance-option" htmlFor={id}>
      <SettingsInput {...props} id={id} />
      {preview}
      <span className="appearance-option-copy">
        <span className="appearance-option-name">{label}</span>
        {hint && <span className="appearance-option-hint">{hint}</span>}
      </span>
    </label>
  )
}

/** Fixed previews share the theme palette. Active-scheme semantic tokens would make both previews
 * identical, so only these miniature illustrations use the explicit light/dark palette roles. */
const SCHEME_LOOK = {
  light: {
    page: 'var(--agnes-color-gray-0)',
    rail: 'var(--agnes-color-gray-50)',
    card: 'var(--agnes-color-gray-0)',
    line: 'var(--agnes-color-gray-150)',
  },
  dark: {
    page: 'var(--agnes-color-gray-925)',
    rail: 'var(--agnes-color-gray-950)',
    card: 'var(--agnes-color-gray-850)',
    line: 'var(--agnes-color-gray-750)',
  },
} as const

/**
 * A thumbnail of a colour scheme: a rail and a card with a few lines of text. `system` is half
 * light and half dark.
 */
export function SchemeThumbnail({ scheme }: { scheme: 'system' | 'light' | 'dark' }) {
  const half = (look: (typeof SCHEME_LOOK)[keyof typeof SCHEME_LOOK], x: number, width: number) => {
    const rail = width * 0.22
    const left = x + 6 + rail + 5
    const right = x + width - 6
    return (
      <>
        <rect x={x} width={width} height="72" fill={look.page} />
        <rect x={x + 6} y="6" width={rail} height="60" rx="4" fill={look.rail} />
        <rect x={left} y="6" width={right - left} height="33" rx="4" fill={look.card} stroke={look.line} />
        {[46, 55, 64].map((y) => (
          <rect key={y} x={left} y={y} width={right - left} height="2" rx="1" fill={look.line} />
        ))}
      </>
    )
  }
  return (
    <svg className="agh-scheme-thumbnail" viewBox="0 0 112 72" aria-hidden="true" focusable="false">
      {scheme === 'system' ? (
        <>
          {half(SCHEME_LOOK.light, 0, 56)}
          {half(SCHEME_LOOK.dark, 56, 56)}
        </>
      ) : (
        half(SCHEME_LOOK[scheme], 0, 112)
      )}
    </svg>
  )
}

/**
 * Read-only code or prompt text. It scrolls inside a fixed height, stays keyboard scrollable, and
 * with `copy` carries a copy button in its corner.
 */
export function SettingsCode({
  label,
  copy,
  ...props
}: HTMLAttributes<HTMLPreElement> & {
  label: string
  /** The text the copy button puts on the clipboard; without it there is no button. */
  copy?: string | undefined
}) {
  return (
    <section aria-label={label} className="agnes-settings-code">
      {copy !== undefined && (
        <CopyButton label={fallbackT('ui.copy')} copiedLabel={fallbackT('ui.copied')} text={copy} />
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll long prompt and JSON blocks. */}
      <pre {...props} tabIndex={0} />
    </section>
  )
}

/**
 * The bottom line of a section that saves: what just happened on the left, the actions on the right
 * with the primary one last.
 */
export function SettingsFooter({
  status,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & DataAttributes & { status?: ReactNode }) {
  return (
    <div {...props} className={['agnes-settings-footer', props.className].filter(Boolean).join(' ')}>
      <span className="agnes-settings-footer-status" role="status">
        {status}
      </span>
      <div className="agnes-settings-actions">{children}</div>
    </div>
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
    slots?: { actions(node: HTMLElement | null): void } | undefined
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
        {actions && frame.actions && createPortal(actions, frame.actions)}
      </>
    )
  // The page's one header line: its title (the breadcrumb's top level) and its actions; the
  // description is read to assistive tech only.
  return (
    <PushHeader
      {...props}
      line
      className={['config-heading', 'agnes-settings-page-heading', props.className].filter(Boolean).join(' ')}
      testIds={{ header: 'settings-page-header' }}
      title={title}
      crumbs={[]}
      description={description}
      headingId={headingId}
      autoFocus={false}
      onBack={noop}
      onCrumb={noop}
      actions={actions}
      actionsRef={slots?.actions}
      actionsClassName="agnes-settings-actions"
    />
  )
}
const noop = () => {}
export function SettingsSaveBar({
  dirty,
  busy = false,
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
  if (!dirty) return null
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

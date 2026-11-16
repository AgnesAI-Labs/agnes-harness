/**
 * The panel's UI primitives. Where AGH has the control (button, switch, segmented control, tabs, field, select,
 * dialog, help tooltip) these are thin adapters over `@agnes/web-ui`, keeping the props the panel's views use; the
 * rest (icons, status dots, tags, disclosure rows) are local and styled with AGH tokens in `superagent.css`.
 */
import {
  SettingsInput,
  SettingsSelect,
  Tabs,
  Tooltip,
  Button as UiButton,
  type ButtonProps as UiButtonProps,
  Icon as UiIcon,
  Switch as UiSwitch,
} from '@agnes/web-ui'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

const ICON_PATHS = {
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevron-up': 'M5 15l7-7 7 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  question:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2',
  shield: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z',
  decision: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.5 2.5 4.5-5',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4V6a1 1 0 0 1 1-1z',
  inbox: 'M4 13l2.5-8h11l2.5 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  hash: 'M10 4L8 20M16 4l-2 16M5 9h15M4 15h15',
  filter: 'M4 5h16l-6 7.5V18l-4 2v-7.5z',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  close: 'M6 6l12 12M18 6L6 18',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  session: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  stop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5h5v5h-5z',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5l11 7-11 7z',
  unsubscribe: 'M6 16v-5a6 6 0 0 1 10-4.5M18 11v5l2 2H8M10 20h4M4 4l16 16',
  dismiss:
    'M4 4l16 16M9.9 5.2A9 9 0 0 1 21 12a12 12 0 0 1-2.4 3.2M6.3 6.4A12 12 0 0 0 3 12c2 4 5.5 6 9 6 1.4 0 2.7-.3 3.9-.9',
  pull: 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16V9a2 2 0 0 0-2-2h-4M13 5l-2 2 2 2',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  review: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M9 13l2 2 4-4',
  ask: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01',
  running: 'M12 3a9 9 0 1 0 9 9',
  blocked: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  queue: 'M4 6h16M4 12h16M4 18h10',
} as const satisfies Record<string, string>
export type IconName = keyof typeof ICON_PATHS
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

const APPEARANCE = { primary: 'primary', ghost: 'ghost', outline: 'secondary' } as const
type ButtonProps = {
  variant?: 'primary' | 'ghost' | 'outline'
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'>
/** The shared AGH button; `variant` and `size` keep the panel's names. */
export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <UiButton
      {...(rest as UiButtonProps)}
      appearance={APPEARANCE[variant]}
      size={size === 'sm' ? 'small' : 'middle'}
      htmlType={type}
      icon={icon}
      className={cx('dt-btn', className)}
    >
      {children}
    </UiButton>
  )
}
/** A link that looks like a secondary button, for an address outside the panel. */
export function LinkButton({
  href,
  icon,
  children,
}: {
  href: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <UiButton
      appearance="secondary"
      size="small"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      icon={icon}
      className="dt-btn"
    >
      {children}
    </UiButton>
  )
}

export type TagTone = 'outline' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
export function Tag({
  tone = 'outline',
  title,
  children,
}: {
  tone?: TagTone
  title?: string
  children: ReactNode
}) {
  return (
    <span className="dt-tag" data-tone={tone} title={title}>
      {children}
    </span>
  )
}

export function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={cx('dt-pill', active && 'dt-pill-active')}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The page's tab bar: the shared AGH tabs. Clicking the active tab emits `onChange` again, so callers can reset to the tab root. */
export function SegmentedTabs<V extends string>({
  items,
  value,
  onChange,
  label,
  id,
  className,
}: {
  items: readonly { value: V; label: string }[]
  value: V
  onChange: (next: V) => void
  label: string
  /** Tab `t` gets the id `${id}-tab-${t}`. */
  id: string
  className?: string
}) {
  return (
    <Tabs
      id={id}
      aria-label={label}
      className={cx('dt-tabs', className)}
      activeKey={value}
      onTabClick={(key) => onChange(key as V)}
      items={items.map((item) => ({ key: item.value, label: item.label }))}
    />
  )
}
/** The shared AGH text field, with an optional leading icon. */
export function Input({
  icon,
  className,
  ...rest
}: { icon?: ReactNode; className?: string | undefined } & InputHTMLAttributes<HTMLInputElement>) {
  if (icon === undefined) return <SettingsInput {...rest} className={cx('dt-input', className)} />
  return (
    <span className={cx('dt-input-icon-wrap', className)}>
      <span className="dt-input-icon">{icon}</span>
      <SettingsInput {...rest} className="dt-input" />
    </span>
  )
}

/** The shared AGH select (a native select, so forms keep their semantics). */
export function Select({
  className,
  ...rest
}: { className?: string | undefined } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <SettingsSelect {...rest} className={cx('dt-select', className)} />
}

/**
 * The shared AGH switch, at its one size. AGH's refinement sizes only antd's default switch (38×22, 18px knob); antd's
 * `small` size reads other variables, so it would keep a 28px track with a 12px knob under AGH's 22px height.
 */
export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  className?: string
}) {
  return (
    <UiSwitch
      checked={checked}
      aria-label={label}
      className={cx('dt-switch', className)}
      onChange={(next) => onChange(next)}
    />
  )
}

export type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
export function StateDot({ state, className }: { state: DotState; className?: string }) {
  if (state === 'ongoing') {
    return (
      <svg
        className={cx('dt-spinner', className)}
        data-state="ongoing"
        width={14}
        height={14}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <g>
          <circle cx="12" cy="12" r="9.5" />
          <circle cx="12" cy="12" r="9.5" />
        </g>
      </svg>
    )
  }
  return <span className={cx('dt-state-dot', className)} data-state={state} aria-hidden="true" />
}
export function Dot({ state, label }: { state: DotState; label?: string }) {
  const dot = <StateDot className="dt-dot" state={state} />
  return label ? (
    <span className="dt-dot-wrap" title={label} role="img" aria-label={label}>
      {dot}
    </span>
  ) : (
    dot
  )
}

export function DisclosureRow({
  icon,
  title,
  open,
  onToggle,
  collapsedContent,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  open: boolean
  onToggle: () => void
  collapsedContent?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="dt-disclosure" data-open={open || undefined}>
      <button
        type="button"
        className="dt-disclosure-row"
        aria-expanded={open}
        data-disclosure-row
        onClick={onToggle}
      >
        <span className="dt-disclosure-lead">
          <span className="dt-disclosure-icon">{icon}</span>
          <span className="dt-disclosure-chevron">
            <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          </span>
        </span>
        <span className="dt-disclosure-title">{title}</span>
        {!open && collapsedContent}
      </button>
      {open && children}
    </div>
  )
}

/** The AGH help affordance: an ⓘ beside a name that shows the explanation on hover or keyboard focus. */
export function InfoTip({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <Tooltip title={text}>
      <span
        className={cx('dt-info', 'agnes-settings-info', warn && 'dt-info-warn')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the explanation by focus.
        tabIndex={0}
        role="note"
        aria-label={text}
      >
        <UiIcon name={warn ? 'triangle-alert' : 'info'} />
      </span>
    </Tooltip>
  )
}

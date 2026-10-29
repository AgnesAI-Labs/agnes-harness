import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, Icon, type IconName, Popover } from '@agnes/web-ui'
import { type KeyboardEvent, type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type PermissionMode = 'view' | 'workspace' | 'full'

export type PermissionOption = {
  id: PermissionMode
  label: string
  description: string
}

const PERMISSION_OPTION_LABEL_KEYS: Record<PermissionMode, string> = {
  view: 'composer.permission.view',
  workspace: 'composer.permission.workspace',
  full: 'composer.permission.full',
}

const PERMISSION_OPTION_DESCRIPTION_KEYS: Record<PermissionMode, string> = {
  view: 'composer.permission.viewDescription',
  workspace: 'composer.permission.workspaceDescription',
  full: 'composer.permission.fullDescription',
}

const PERMISSION_OPTION_HINT_KEYS: Record<PermissionMode, string> = {
  view: 'composer.permission.viewHint',
  workspace: 'composer.permission.workspaceHint',
  full: 'composer.permission.fullHint',
}

/** One glyph per mode; the trigger shows the selected mode's glyph. */
const PERMISSION_ICONS: Record<PermissionMode, IconName> = {
  view: 'eye',
  workspace: 'shield-check',
  full: 'shield-alert',
}

export function permissionIcon(mode: PermissionMode | null): IconName {
  return mode ? PERMISSION_ICONS[mode] : 'shield'
}

/** Static id rows: resolve label/description through tr at render time, not module load time. */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  {
    id: 'view',
    label: PERMISSION_OPTION_LABEL_KEYS.view,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.view,
  },
  {
    id: 'workspace',
    label: PERMISSION_OPTION_LABEL_KEYS.workspace,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.workspace,
  },
  {
    id: 'full',
    label: PERMISSION_OPTION_LABEL_KEYS.full,
    description: PERMISSION_OPTION_DESCRIPTION_KEYS.full,
  },
]

export function permissionLabel(mode: PermissionMode | null): string {
  if (mode === null) return tr('settings.picker.choosePermission')
  return tr(PERMISSION_OPTION_LABEL_KEYS[mode] ?? PERMISSION_OPTION_LABEL_KEYS.workspace)
}

export function yoloEnabled(mode: PermissionMode): boolean {
  return mode === 'full'
}

const NO_MOTION = { motionName: '' }

export type PermissionPickerState = {
  isolationNote?: string
  disabled: boolean
  pending: boolean
  selected: PermissionMode | null
  /** The level new sessions start under, marked in the list; absent when the Host does not say. */
  defaultMode?: PermissionMode
}

export type PermissionPickerProps = {
  state: PermissionPickerState
  onError(error: unknown): void
  onSelect(mode: PermissionMode): Promise<boolean>
}

/**
 * Session approval mode. The app keeps the confirmed mode; this component owns the transient
 * list only. A choice is sent at once and the list collapses when the host accepts it.
 */
/**
 * The chip sits at the composer's left edge on a phone, where a right-aligned panel flips past the
 * window's right edge. Like the model picker, shift it back into view instead.
 */
export const PERMISSION_PANEL_ALIGN = { overflow: { shiftX: true, adjustX: true, adjustY: true } }

export function PermissionPickerControl({ state, onSelect, onError }: PermissionPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const disabled = state.disabled || state.pending
  const label = permissionLabel(state.selected)

  // The host disables the trigger while a change is pending; return focus once it is usable again.
  useEffect(() => {
    if (open || disabled || !refocus.current) return
    refocus.current = false
    trigger.current?.focus({ preventScroll: true })
  }, [open, disabled])
  useEffect(() => {
    if (state.disabled) setOpen(false)
  }, [state.disabled])

  const close = (returnFocus: boolean): void => {
    refocus.current = returnFocus
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      trigger="click"
      placement="topRight"
      align={PERMISSION_PANEL_ALIGN}
      arrow={false}
      destroyOnHidden={true}
      // Opened many times a day, often from the keyboard: no entrance or exit motion.
      motion={NO_MOTION}
      rootClassName="permission-picker-surface"
      onOpenChange={(next) => {
        if (next && disabled) return
        if (next) setOpen(true)
        else if (!busy) close(false)
      }}
      content={
        <PermissionPanel state={state} onSelect={onSelect} onError={onError} close={close} onBusy={setBusy} />
      }
    >
      <Button
        ref={trigger}
        id="composer-permission"
        className="composer-permission"
        appearance="ghost"
        htmlType="button"
        data-permission={state.selected ?? 'unknown'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'permission-listbox' : undefined}
        aria-label={tr('settings.picker.aria')}
        aria-busy={state.pending || busy}
        title={[label, state.isolationNote].filter(Boolean).join(' · ')}
        disabled={disabled}
        onKeyDown={(event) => {
          if (disabled || open || event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Icon name={permissionIcon(state.selected)} />
        <span data-permission-label={true}>{label}</span>
        {state.isolationNote && <span data-isolation-note={true}>{state.isolationNote}</span>}
        <Icon name="chevron-down" className="model-chevron" />
      </Button>
    </Popover>
  )
}

function PermissionPanel({
  state,
  onSelect,
  onError,
  close,
  onBusy,
}: PermissionPickerProps & { close(returnFocus: boolean): void; onBusy(busy: boolean): void }): ReactElement {
  const selectedIndex = PERMISSION_OPTIONS.findIndex((option) => option.id === state.selected)
  const [active, setActive] = useState(selectedIndex >= 0 ? selectedIndex : 1)
  const [selecting, setSelecting] = useState(false)
  const request = useRef(0)
  const listbox = useRef<HTMLDivElement>(null)
  const busy = state.pending || selecting

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once, when the panel mounts.
  useLayoutEffect(() => {
    listbox.current?.focus({ preventScroll: true })
    return () => {
      // A reply that lands after the panel closed must not touch it.
      request.current += 1
      onBusy(false)
    }
  }, [])

  async function select(index: number): Promise<void> {
    const option = PERMISSION_OPTIONS[index]
    if (!option || state.disabled || busy) return
    const current = ++request.current
    setSelecting(true)
    onBusy(true)
    try {
      const accepted = await onSelect(option.id)
      if (current === request.current && accepted) close(true)
    } catch (error) {
      if (current === request.current) onError(error)
    } finally {
      if (current === request.current) {
        setSelecting(false)
        onBusy(false)
      }
    }
  }

  function keys(event: KeyboardEvent<HTMLElement>): void {
    const count = PERMISSION_OPTIONS.length
    const move = (index: number) => {
      event.preventDefault()
      setActive((index + count) % count)
    }
    if (event.key === 'ArrowDown') move(active + 1)
    else if (event.key === 'ArrowUp') move(active - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(count - 1)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void select(active)
    }
  }

  return (
    <section
      id="permission-picker-popover"
      className="permission-picker"
      aria-label={tr('settings.picker.aria')}
    >
      <div
        ref={listbox}
        id="permission-listbox"
        className="permission-picker-list"
        role="listbox"
        tabIndex={-1}
        aria-label={tr('settings.picker.listAria')}
        aria-busy={busy}
        aria-activedescendant={`permission-picker-option-${active}`}
        onKeyDown={keys}
      >
        {PERMISSION_OPTIONS.map((option, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keyboard through aria-activedescendant.
          <div
            id={`permission-picker-option-${index}`}
            key={option.id}
            className="permission-picker-option"
            role="option"
            tabIndex={-1}
            aria-selected={option.id === state.selected}
            aria-disabled={busy}
            data-active={index === active}
            data-permission={option.id}
            // The full explanation is one hover away; the row itself stays one short line.
            title={tr(option.description)}
            onMouseMove={() => setActive(index)}
            onClick={() => void select(index)}
          >
            <Icon name={PERMISSION_ICONS[option.id]} className="permission-picker-icon" />
            <span className="permission-picker-copy">
              <span className="permission-picker-label">
                {tr(option.label)}
                {option.id === state.defaultMode ? ` ${tr('settings.picker.defaultMark')}` : ''}
              </span>
              <span className="permission-picker-hint">{tr(PERMISSION_OPTION_HINT_KEYS[option.id])}</span>
            </span>
            <span className="permission-picker-check">
              {option.id === state.selected ? <Icon name="check" /> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

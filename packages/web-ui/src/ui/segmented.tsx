import { type ReactNode, type Ref, useId, useLayoutEffect, useRef } from 'react'
import { Button } from './button.js'

export type SegmentedOption<Value extends string = string> = {
  value: Value
  label: ReactNode
  disabled?: boolean
  testId?: string
  id?: string
  controls?: string
  buttonRef?: Ref<HTMLButtonElement> | undefined
}
export type SegmentedProps<Value extends string = string> = {
  label: string
  value: Value | undefined
  options: readonly SegmentedOption<Value>[]
  onChange(value: Value): void
  disabled?: boolean
  block?: boolean
  name?: string
  id?: string
  testId?: string
  className?: string
  /** Tabs retain existing view-controller anchors; all other single choices are native radios. */
  navigation?: 'radio' | 'tabs'
  hostRef?: Ref<HTMLDivElement>
}

/**
 * Only 2–5 fixed, short, single-line labels in both zh and en, without descriptions/sub-text.
 * Plugin-driven or dynamic counts, long labels and descriptive choices use SettingsChoice rows
 * (or a Select for long lists). A radiogroup does not imply a Segmented presentation.
 * Shares the topbar's track, measured sliding thumb and keyboard behaviour.
 */
export function Segmented<Value extends string = string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  block = false,
  name,
  id,
  testId,
  className,
  navigation = 'radio',
  hostRef,
}: SegmentedProps<Value>) {
  const generated = useId()
  const host = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || !options.some((option) => option.value === value)) return
    const measure = () => {
      const selected = element.querySelector<HTMLElement>('.agh-segmented-option[data-selected="true"]')
      if (!selected?.offsetWidth) return
      element.style.setProperty('--agh-segment-thumb-left', `${selected.offsetLeft}px`)
      element.style.setProperty('--agh-segment-thumb-width', `${selected.offsetWidth}px`)
    }
    measure()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(element)
    for (const child of element.children) resize?.observe(child)
    return () => resize?.disconnect()
  }, [value, options])
  const tabStop =
    options.find((option) => option.value === value && !option.disabled)?.value ??
    options.find((option) => !option.disabled)?.value
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: the group role is either tablist or radiogroup, both keyboard accessible.
    <div
      ref={(node) => {
        host.current = node
        if (typeof hostRef === 'function') hostRef(node)
        else if (hostRef) (hostRef as { current: HTMLDivElement | null }).current = node
      }}
      role={navigation === 'tabs' ? 'tablist' : 'radiogroup'}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-view={navigation === 'tabs' ? value : undefined}
      id={id}
      data-testid={testId}
      data-block={block || undefined}
      className={['agh-segmented', className].filter(Boolean).join(' ')}
      onKeyDown={(event) => {
        const delta = ['ArrowRight', 'ArrowDown'].includes(event.key)
          ? 1
          : ['ArrowLeft', 'ArrowUp'].includes(event.key)
            ? -1
            : 0
        if (!delta && !['Home', 'End'].includes(event.key)) return
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
            'input:not(:disabled), button:not(:disabled)',
          ),
        ]
        if (!controls.length) return
        event.preventDefault()
        const current = controls.indexOf(event.target as HTMLInputElement | HTMLButtonElement)
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? controls.length - 1
              : (current + delta + controls.length) % controls.length
        controls[index]?.focus({ preventScroll: true })
        controls[index]?.click()
      }}
    >
      <span className="agh-segmented-thumb" aria-hidden="true" />
      {options.map((option, index) =>
        navigation === 'tabs' ? (
          <Button
            key={option.value}
            className="agh-segmented-option"
            appearance="ghost"
            size="small"
            ref={option.buttonRef}
            id={option.id}
            role="tab"
            aria-selected={option.value === value}
            aria-controls={option.controls}
            aria-posinset={index + 1}
            aria-setsize={options.length}
            data-selected={option.value === value}
            data-testid={option.testId}
            tabIndex={option.value === tabStop ? 0 : -1}
            disabled={disabled || !!option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ) : (
          <label key={option.value} className="agh-segmented-option" data-selected={option.value === value}>
            <input
              type="radio"
              name={name ?? generated}
              id={option.id}
              value={option.value}
              checked={option.value === value}
              disabled={disabled || option.disabled}
              tabIndex={option.value === tabStop ? 0 : -1}
              data-testid={option.testId}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ),
      )}
    </div>
  )
}

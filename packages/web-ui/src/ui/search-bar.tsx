import type { InputHTMLAttributes, ReactNode } from 'react'
import { Icon } from './icon.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

export type SearchBarProps = {
  /** Accessible name of the search field; the placeholder is only an example. */
  label: string
  value?: string
  onChange?(value: string): void
  /** Called for Enter in the field. Omit for filter-as-you-type. */
  onSubmit?(): void
  placeholder?: string
  /** Optional narrowing controls shown beside the field. */
  filters?: ReactNode
  /** The submit button or other trailing actions. */
  actions?: ReactNode
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & DataAttributes
  className?: string
  'data-testid'?: string
}

/**
 * One search field with optional filters: a page never asks for a query in several bare inputs.
 * It is a landmark, not a form, so it can sit inside a host form without submitting it.
 */
export function SearchBar({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  filters,
  actions,
  inputProps,
  className,
  ...props
}: SearchBarProps) {
  return (
    <div {...props} role="search" className={['agh-search-bar', className].filter(Boolean).join(' ')}>
      <label className="agh-search-bar-field" htmlFor={inputProps?.id}>
        <Icon name="search" />
        <span className="visually-hidden">{label}</span>
        <input
          autoComplete="off"
          {...inputProps}
          type="search"
          placeholder={placeholder}
          {...(value === undefined ? {} : { value })}
          {...(onChange ? { onChange: (event) => onChange(event.target.value) } : {})}
          onKeyDown={(event) => {
            inputProps?.onKeyDown?.(event)
            if (event.key !== 'Enter' || event.defaultPrevented || !onSubmit) return
            event.preventDefault()
            onSubmit()
          }}
        />
      </label>
      {filters && <div className="agh-search-bar-filters">{filters}</div>}
      {actions && <div className="agh-search-bar-actions">{actions}</div>}
    </div>
  )
}

import { Select } from './ui/select.js'

export type SessionOption = {
  id: string
  title: string
  workspace: string
  createdAt: string
}
/** Caller supplies backend-owned choices. Raw identities are values, never labels. */
export function SessionPicker({
  sessions,
  value,
  onChange,
  label,
  locale = 'en',
  disabled = false,
  id,
  testId,
}: {
  sessions: readonly SessionOption[]
  value: string | undefined
  onChange(id: string): void
  label: string
  locale?: string
  disabled?: boolean
  id?: string
  testId?: string
}) {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const text = (session: SessionOption) => {
    const days = Math.round((Date.parse(session.createdAt) - Date.now()) / 86_400_000)
    return [session.title, session.workspace, Number.isFinite(days) ? relative.format(days, 'day') : '']
      .filter(Boolean)
      .join(' · ')
  }
  return (
    <Select<string>
      {...(id ? { id } : {})}
      data-testid={testId}
      aria-label={label}
      value={value || null}
      disabled={disabled}
      showSearch={sessions.length > 7}
      optionFilterProp="label"
      options={sessions.map((session) => ({ value: session.id, label: text(session) }))}
      onChange={onChange}
    />
  )
}

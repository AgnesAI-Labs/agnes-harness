import { Button, SettingsBlock, SettingsInput, SettingsItem, useUiText } from '@agnes/web-ui'
import { useMemo, useState } from 'react'
import { clearEntryExpiry, deleteEntry, memoryEntries, setEntryExpiry } from './memory-entries.js'
import { useDeadlineTick } from './memory-expiry.js'
import { memoryCatalog } from './memory-locale.js'

function localDateTime(time: number) {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

function utcSeconds(time: number) {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

/** Try the UTC offsets on both sides of a possible transition, then verify the wall clock. */
export function localExpiryCandidates(local: string) {
  const wall = local.length === 16 ? `${local}:00` : local
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(wall)) return []
  const time = Date.parse(wall + 'Z')
  if (!Number.isFinite(time)) return []
  const offsets = new Set([-1, 0, 1].map((days) => new Date(time + days * 86_400_000).getTimezoneOffset()))
  return [...offsets]
    .map((offset) => time + offset * 60_000)
    .filter((candidate) => localDateTime(candidate) === wall)
    .map(utcSeconds)
    .filter((iso) => /^\d{4}-/u.test(iso))
    .sort()
}

export function MemoryEntriesBlock(props: {
  content: string
  disabled: boolean
  dirty: boolean
  memoryOff: boolean
  onSave(content: string): void
}) {
  const { content, dirty, memoryOff, onSave } = props
  const disabled = props.disabled || dirty
  const { t, locale } = useUiText('@agnes/web/memory', memoryCatalog)
  const entries = useMemo(() => memoryEntries(content), [content])
  const [editing, setEditing] = useState<{ start: number; initialLocal: string; initialIso: string }>()
  const [local, setLocal] = useState('')
  const [choice, setChoice] = useState('')
  const now = Date.now()
  let earliest: number | undefined
  for (const entry of entries)
    for (const { expiresAt } of entry.expiry)
      if (expiresAt > now && (earliest === undefined || expiresAt < earliest)) earliest = expiresAt
  useDeadlineTick(earliest)
  if (!entries.length) return null
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' })
  const candidates = localExpiryCandidates(local)
  const initialIso =
    editing && (editing.initialLocal === local || candidates.includes(editing.initialIso))
      ? editing.initialIso
      : ''
  const timestamp = choice || initialIso || (candidates.length === 1 ? candidates[0] : '')
  return (
    <SettingsBlock label={t('entries.title')} data-testid="memory-entries">
      <p className="agnes-settings-note">{t('entries.help')}</p>
      {memoryOff && <p className="agnes-settings-note">{t('expiry.off')}</p>}
      {dirty && (
        <p className="agnes-settings-note" role="status">
          {t('entries.dirty')}
        </p>
      )}
      {entries.map((entry) => {
        const deadline = Math.min(...entry.expiry.map((line) => line.expiresAt))
        const status = !entry.expiry.length
          ? t('entries.valid')
          : Number.isNaN(deadline)
            ? t('entries.invalid')
            : deadline <= now
              ? t('entries.expired')
              : t('entries.future', { date: date.format(deadline) })
        const preview = Array.from(entry.preview)
        return (
          <SettingsItem
            key={entry.start}
            label={
              <span translate="no">
                {preview.length > 80 ? preview.slice(0, 79).join('') + '…' : entry.preview}
              </span>
            }
            description={status}
          >
            <Button
              size="small"
              disabled={disabled}
              aria-expanded={editing?.start === entry.start}
              onClick={() => {
                const initialLocal = Number.isFinite(deadline) ? localDateTime(deadline) : ''
                const initialIso = Number.isFinite(deadline) ? utcSeconds(deadline) : ''
                setEditing(
                  editing?.start === entry.start
                    ? undefined
                    : { start: entry.start, initialLocal, initialIso },
                )
                setLocal(initialLocal)
                setChoice('')
              }}
            >
              {t(entry.expiry.length ? 'entries.edit' : 'entries.set')}
            </Button>
            {editing?.start === entry.start && (
              <>
                {[7, 30].map((days) => (
                  <Button
                    key={days}
                    size="small"
                    disabled={disabled}
                    onClick={() => {
                      setEditing(undefined)
                      onSave(setEntryExpiry(content, entry, utcSeconds(Date.now() + days * 86_400_000)))
                    }}
                  >
                    {t('entries.days', { days })}
                  </Button>
                ))}
                <SettingsInput
                  aria-label={t('entries.local')}
                  type="datetime-local"
                  step={1}
                  disabled={disabled}
                  value={local}
                  onChange={(event) => {
                    setLocal(event.target.value)
                    setChoice('')
                  }}
                />
                {candidates.length > 1 && (
                  <fieldset>
                    <legend>{t('entries.overlap')}</legend>
                    {candidates.map((iso) => (
                      <Button
                        key={iso}
                        size="small"
                        aria-pressed={timestamp === iso}
                        disabled={disabled}
                        onClick={() => setChoice(iso)}
                      >
                        {iso}
                      </Button>
                    ))}
                  </fieldset>
                )}
                <Button
                  size="small"
                  disabled={disabled || !timestamp}
                  onClick={() => {
                    if (!timestamp) return
                    setEditing(undefined)
                    onSave(timestamp === initialIso ? content : setEntryExpiry(content, entry, timestamp))
                  }}
                >
                  {t('save')}
                </Button>
              </>
            )}
            {!!entry.expiry.length && (
              <Button
                size="small"
                disabled={disabled}
                onClick={() => onSave(clearEntryExpiry(content, entry))}
              >
                {t('entries.clear')}
              </Button>
            )}
            <Button size="small" disabled={disabled} onClick={() => onSave(deleteEntry(content, entry))}>
              {t('entries.delete')}
            </Button>
          </SettingsItem>
        )
      })}
    </SettingsBlock>
  )
}

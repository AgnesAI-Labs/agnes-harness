import { IconButton, SettingsInput } from '@agnes/web-ui'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Translate } from './locales/index.js'

export type TitleEditRequest = {
  sessionId: string
  title: string
  save(title: string): Promise<void>
}

/** Local draft only; the host owns validation, the write and the shared title refresh. */
export function TopbarTitleEditor({
  request,
  onFinish,
  t,
}: {
  request: TitleEditRequest
  onFinish(): void
  t: Translate
}) {
  const [draft, setDraft] = useState(request.title)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const active = useRef(true)
  const saving = useRef(false)
  const composing = useRef(false)
  const errorId = useId()
  useEffect(() => {
    active.current = true
    input.current?.focus()
    input.current?.select()
    return () => {
      active.current = false
    }
  }, [])
  const finish = () => {
    onFinish()
    requestAnimationFrame(() => document.getElementById('task-title')?.focus())
  }
  function cancelOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || composing.current) return
    event.preventDefault()
    if (!saving.current) finish()
  }
  async function save() {
    if (saving.current || composing.current) return
    const title = draft.trim()
    if (!title) {
      setError(t('topbar.rename.invalid'))
      input.current?.focus()
      return
    }
    if (title === request.title.trim()) {
      finish()
      return
    }
    saving.current = true
    setPending(true)
    setError('')
    try {
      await request.save(title)
      if (active.current) finish()
    } catch (failure) {
      if (active.current) {
        setError(failure instanceof Error ? failure.message : t('topbar.rename.failed'))
        input.current?.focus()
      }
    } finally {
      saving.current = false
      if (active.current) setPending(false)
    }
  }
  return (
    <span className="topbar-title-editor" aria-busy={pending}>
      <SettingsInput
        ref={input}
        id="task-title-input"
        aria-label={t('topbar.rename.name')}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        value={draft}
        readOnly={pending}
        onChange={(event) => {
          setDraft(event.target.value)
          setError('')
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void save()
          }
          cancelOnEscape(event)
        }}
      />
      <IconButton
        name="check"
        label={t('topbar.rename.save')}
        data-testid="task-title-save"
        onKeyDown={cancelOnEscape}
        disabled={pending}
        onClick={() => void save()}
      />
      <IconButton
        name="x"
        label={t('topbar.rename.cancel')}
        data-testid="task-title-cancel"
        onKeyDown={cancelOnEscape}
        disabled={pending}
        onClick={finish}
      />
      {error && (
        <span id={errorId} className="topbar-title-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

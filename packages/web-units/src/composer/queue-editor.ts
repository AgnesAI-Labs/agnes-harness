import { type ChangeEvent, createElement, useState } from 'react'
import { type ComposerDependencies } from './contracts.js'

export function QueuedInputEditor({
  text,
  disabled,
  save,
  t,
  onError,
}: {
  text: string
  disabled?: boolean
  save: (text: string) => Promise<void>
  t: ComposerDependencies['translate']
  onError: (error: unknown) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [pending, setPending] = useState(false)
  return createElement(
    'div',
    null,
    editing
      ? createElement('textarea', {
          'data-testid': 'queued-steer-editor',
          'aria-label': t('composer.queue.edit'),
          value: draft,
          disabled: disabled || pending,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
        })
      : null,
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'queued-steer-edit',
        disabled: disabled || pending || (editing && !draft.trim()),
        onClick: () => {
          if (!editing) {
            setDraft(text)
            setEditing(true)
            return
          }
          setPending(true)
          void save(draft)
            .then(() => setEditing(false))
            .catch(onError)
            .finally(() => setPending(false))
        },
      },
      t(editing ? 'composer.queue.save' : 'composer.queue.edit'),
    ),
    editing
      ? createElement(
          'button',
          { type: 'button', disabled: pending, onClick: () => setEditing(false) },
          t('composer.queue.discardEdit'),
        )
      : null,
  )
}

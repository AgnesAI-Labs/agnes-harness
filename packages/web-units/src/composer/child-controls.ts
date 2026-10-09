import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import { type ChangeEvent, createElement, type ReactNode, useState } from 'react'
import { type ComposerDependencies } from './contracts.js'

export function ChildControlTree({
  children,
  disabled,
  control,
  t,
}: {
  children: readonly SessionControlledChild[]
  disabled?: boolean
  control: (id: string, action: 'stop' | 'continue', text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const ids = new Set(children.map((child) => child.id))
  const renderChild = (child: SessionControlledChild, seen = new Set<string>()): ReactNode => {
    if (seen.has(child.id)) return null
    const next = new Set([...seen, child.id])
    return createElement(
      'li',
      { key: child.id },
      createElement(ChildControlRow, { child, disabled, control, t }),
      createElement(
        'ul',
        null,
        children.filter((row) => row.parentId === child.id).map((row) => renderChild(row, next)),
      ),
    )
  }
  return createElement(
    'details',
    { 'data-testid': 'child-control-tree' },
    createElement('summary', null, t('composer.child.title')),
    createElement(
      'ul',
      null,
      children.filter((child) => !ids.has(child.parentId)).map((child) => renderChild(child)),
    ),
  )
}

export function ChildControlRow({
  child,
  disabled,
  control,
  t,
}: {
  child: SessionControlledChild
  disabled?: boolean
  control: (id: string, action: 'stop' | 'continue', text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const submit = (action: 'stop' | 'continue') => {
    if (pending) return
    setPending(true)
    setError('')
    void control(child.id, action, action === 'continue' ? text : undefined)
      .then(() => {
        if (action === 'continue') setText('')
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setPending(false))
  }
  return createElement(
    'div',
    { 'data-testid': 'child-control-row', 'data-child-id': child.id },
    createElement('a', { href: '?session=' + encodeURIComponent(child.id) }, child.id),
    createElement('span', { role: 'status' }, t('composer.child.' + child.status)),
    createElement(
      'p',
      { 'data-testid': 'child-control-metrics' },
      t('composer.child.metrics', {
        tokens: child.totalTokens ?? t('composer.child.unknown'),
        seconds:
          child.durationMs === null ? t('composer.child.unknown') : (child.durationMs / 1000).toFixed(1),
      }),
    ),
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'child-stop',
        disabled: disabled || pending || !child.controls.stop,
        title: child.controls.stop ? t('composer.child.stop') : t('composer.control.unsupported'),
        onClick: () => submit('stop'),
      },
      t('composer.child.stop'),
    ),
    createElement('input', {
      'data-testid': 'child-continue-message',
      'aria-label': t('composer.child.message'),
      value: text,
      disabled: disabled || pending || !child.controls.continue,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.currentTarget.value),
    }),
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'child-continue',
        disabled: disabled || pending || !child.controls.continue || !text.trim(),
        title: child.controls.continue ? t('composer.child.continue') : t('composer.control.unsupported'),
        onClick: () => submit('continue'),
      },
      t('composer.child.continue'),
    ),
    error ? createElement('p', { role: 'alert' }, error) : null,
  )
}

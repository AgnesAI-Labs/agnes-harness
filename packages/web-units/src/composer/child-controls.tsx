import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import { Button, Disclosure, SettingsInput, SettingsState } from '@agnes/web-ui'
import { type ChangeEvent, type ReactNode, useState } from 'react'
import type { ComposerDependencies } from './contracts.js'

export function ChildControlTree({
  nodes,
  disabled = false,
  control,
  t,
}: {
  nodes: readonly SessionControlledChild[]
  disabled?: boolean
  control: (id: string, action: 'stop' | 'continue', text?: string) => Promise<void>
  t: ComposerDependencies['translate']
}) {
  const ids = new Set(nodes.map((child) => child.id))
  const renderChild = (child: SessionControlledChild, seen = new Set<string>()): ReactNode => {
    if (seen.has(child.id)) return null
    const next = new Set([...seen, child.id])
    return (
      <li key={child.id}>
        <ChildControlRow child={child} disabled={disabled} control={control} t={t} />
        <ul>{nodes.filter((row) => row.parentId === child.id).map((row) => renderChild(row, next))}</ul>
      </li>
    )
  }
  return (
    <Disclosure variant="plain" data-testid="child-control-tree" summary={t('composer.child.title')}>
      <ul>{nodes.filter((child) => !ids.has(child.parentId)).map((child) => renderChild(child))}</ul>
    </Disclosure>
  )
}

export function ChildControlRow({
  child,
  disabled = false,
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
      .catch((error: unknown) =>
        setError(
          t('composer.child.controlFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      .finally(() => setPending(false))
  }
  return (
    <div data-testid="child-control-row" data-child-id={child.id}>
      <a href={'?session=' + encodeURIComponent(child.id)}>{child.id}</a>
      <span role="status">{t('composer.child.' + child.status)}</span>
      <p data-testid="child-control-metrics">
        {t('composer.child.metrics', {
          tokens: child.totalTokens ?? t('composer.child.unknown'),
          seconds:
            child.durationMs === null ? t('composer.child.unknown') : (child.durationMs / 1000).toFixed(1),
        })}
      </p>
      {child.controls.stop ? (
        <Button
          htmlType="button"
          data-testid="child-stop"
          disabled={disabled || pending}
          title={t('composer.child.stop')}
          onClick={() => submit('stop')}
        >
          {t('composer.child.stop')}
        </Button>
      ) : null}
      {child.controls.continue ? (
        <>
          <SettingsInput
            data-testid="child-continue-message"
            aria-label={t('composer.child.message')}
            placeholder={t('composer.child.message')}
            value={text}
            disabled={disabled || pending}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.currentTarget.value)}
          />
          <Button
            htmlType="button"
            data-testid="child-continue"
            disabled={disabled || pending || !text.trim()}
            title={text.trim() ? t('composer.child.continue') : t('composer.child.messageRequired')}
            onClick={() => submit('continue')}
          >
            {t('composer.child.continue')}
          </Button>
        </>
      ) : null}
      {error ? <SettingsState tone="error">{error}</SettingsState> : null}
    </div>
  )
}

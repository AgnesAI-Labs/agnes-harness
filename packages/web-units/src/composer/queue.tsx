import { Button, Icon, IconButton, Menu, SettingsTextArea, Tooltip } from '@agnes/web-ui'
import { type ChangeEvent, type RefObject, useRef, useState } from 'react'
import type { ComposerProps, ComposerView } from './contracts.js'

type ComposerOptions<K extends keyof ComposerProps> = { [P in K]: ComposerProps[P] }
type QueueOptions = ComposerOptions<
  'dependencies' | 'onSendNow' | 'onPromoteQueued' | 'onEditQueued' | 'onRemoveQueued' | 'onError'
> & {
  view: ComposerView
  prompt: RefObject<HTMLTextAreaElement>
}
type QueueItem = NonNullable<ComposerView['queue']>['items'][number]

/**
 * One queued message: a line of text whose actions appear on hover or focus. The row itself takes
 * focus; Delete removes it and Enter edits it. Editing replaces the line with the text box.
 */
function QueueRow({
  item,
  index,
  view,
  dependencies,
  onSendNow,
  onPromoteQueued,
  onEditQueued,
  onRemoveQueued,
  onError,
  prompt,
}: QueueOptions & { item: QueueItem; index: number }) {
  const t = dependencies.translate
  const queue = view.queue
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const changeDisabled = queue?.removeDisabled ?? queue?.disabled ?? false
  const text = item.preview || t('composer.queue.attachment')
  const startEdit = () => {
    if (!onEditQueued || changeDisabled) return
    setDraft(item.editText ?? item.preview)
    setEditing(true)
  }
  const stopEdit = () => {
    setEditing(false)
    requestAnimationFrame(() => row.current?.focus())
  }
  const save = () => {
    if (!onEditQueued || !draft.trim()) return
    setPending(true)
    void onEditQueued(item.itemId, draft)
      .then(stopEdit)
      .catch(onError)
      .finally(() => setPending(false))
  }
  const remove = () => {
    if (!onRemoveQueued || changeDisabled) return
    onRemoveQueued(item.itemId)
    prompt.current?.focus()
  }
  const sendDisabled = queue?.disabled || !onSendNow || queue?.interruptSupported === false
  const sending = queue?.sending === item.itemId
  return (
    <li
      ref={row}
      data-queue-item={item.itemId}
      data-testid="queued-steer"
      data-editing={editing || undefined}
      tabIndex={editing ? -1 : 0}
      aria-label={text}
      onKeyDown={(event) => {
        // Only the row's own keys: its buttons and the text box keep theirs.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          remove()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          startEdit()
        }
      }}
    >
      {editing ? (
        <div className="composer-queue-edit">
          <SettingsTextArea
            data-testid="queued-steer-editor"
            aria-label={t('composer.queue.edit')}
            value={draft}
            autoFocus
            disabled={changeDisabled || pending}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                stopEdit()
              }
            }}
          />
          <div className="composer-queue-edit-actions">
            <Button htmlType="button" size="small" disabled={pending} onClick={stopEdit}>
              {t('composer.queue.discardEdit')}
            </Button>
            <Button
              htmlType="button"
              size="small"
              appearance="primary"
              data-testid="queued-steer-edit"
              disabled={changeDisabled || pending || !draft.trim()}
              onClick={save}
            >
              {t('composer.queue.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="composer-queue-row">
          <Icon name="message-square" className="composer-queue-icon" />
          <span className="composer-queue-preview" title={item.preview}>
            {text}
          </span>
          {/* Guidance already joins at the next step; it says so instead of offering to. */}
          {item.kind === 'steer' ? (
            <span className="composer-queue-kind">{t('composer.queue.nextStep')}</span>
          ) : null}
          <span className="composer-queue-actions">
            {onPromoteQueued && item.kind !== 'steer' ? (
              <Tooltip
                title={
                  queue?.promoteSupported === false ? (queue.reason ?? '') : t('composer.queue.promoteTitle')
                }
              >
                <Button
                  className="composer-queue-send composer-queue-promote"
                  htmlType="button"
                  size="small"
                  disabled={queue?.disabled || queue?.promoteSupported === false}
                  data-testid="queued-steer-promote"
                  aria-label={t('composer.queue.promoteAccessible', { index: index + 1 })}
                  aria-busy={queue?.promoting === item.itemId}
                  onClick={() => {
                    onPromoteQueued(item.itemId)
                    prompt.current?.focus()
                  }}
                >
                  {/* A narrow card keeps the icon; the label and the tooltip still say it. */}
                  <Icon name="send" className="composer-queue-send-icon" />
                  <span className="composer-queue-send-label">{t('composer.queue.promote')}</span>
                </Button>
              </Tooltip>
            ) : null}
            {onEditQueued ? (
              <Tooltip title={t('composer.queue.edit')}>
                <Button
                  htmlType="button"
                  appearance="ghost"
                  size="small"
                  className="composer-queue-tool"
                  data-testid="queued-steer-edit"
                  disabled={changeDisabled}
                  aria-label={t('composer.queue.editAccessible', { index: index + 1 })}
                  icon={<Icon name="pencil" size={16} />}
                  onClick={startEdit}
                />
              </Tooltip>
            ) : null}
            {onRemoveQueued ? (
              <Tooltip title={t('composer.queue.remove')}>
                <Button
                  htmlType="button"
                  appearance="ghost"
                  size="small"
                  className="composer-queue-tool composer-queue-remove"
                  data-testid="queued-steer-withdraw"
                  disabled={changeDisabled}
                  aria-label={t('composer.queue.removeAccessible', { index: index + 1 })}
                  aria-busy={queue?.removing === item.itemId}
                  icon={<Icon name="trash-2" size={16} />}
                  onClick={remove}
                />
              </Tooltip>
            ) : null}
            {/* Interrupting is the rare, strong action: it stops the current step, so it waits in the menu. */}
            {onSendNow ? (
              <Menu
                label={t('composer.queue.more')}
                trigger={
                  <IconButton
                    name="ellipsis"
                    className="composer-queue-tool composer-queue-more"
                    data-testid="queued-steer-more"
                    label={t('composer.queue.more')}
                    disabled={sendDisabled}
                    aria-busy={sending}
                  />
                }
                items={[
                  {
                    id: 'interrupt',
                    label: t(sending ? 'composer.queue.sending' : 'composer.queue.send'),
                    testId: 'queued-steer-interrupt',
                    disabled: sendDisabled,
                    onSelect: () => {
                      onSendNow(item.itemId)
                      prompt.current?.focus()
                    },
                  },
                ]}
              />
            ) : null}
          </span>
        </div>
      )}
    </li>
  )
}

/**
 * Messages written while the agent works wait in a small tray joined to the top of the card. Its
 * heading says when they arrive; while the session is paused the paused strip says that instead.
 */
export function renderComposerQueue(options: QueueOptions) {
  const { view, dependencies } = options
  const queue = view.queue
  if (!queue || (queue.items.length === 0 && !queue.error)) return null
  const t = dependencies.translate
  const count = queue.items.length
  const paused = view.controls?.paused === true
  return (
    <section className="composer-queue" aria-label={t('composer.queue.label')}>
      {count > 0 && !paused ? (
        <p className="composer-queue-count" aria-live="polite">
          <b className="composer-queue-total">{t('composer.queue.count', { count })}</b>
          {` · ${t('composer.queue.when')}`}
        </p>
      ) : null}
      {count > 0 ? (
        <ol className="composer-queue-list">
          {queue.items.map((item, index) => (
            <QueueRow key={item.itemId} {...options} item={item} index={index} />
          ))}
        </ol>
      ) : null}
      {queue.error ? (
        <p className="composer-queue-error" role="alert">
          {queue.error}
        </p>
      ) : null}
    </section>
  )
}

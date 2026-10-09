import { QueuedInputEditor } from './queue-editor.js'
import { createElement, type RefObject } from 'react'
import type { ComposerProps, ComposerView } from './contracts.js'

type ComposerOptions<K extends keyof ComposerProps> = { [P in K]: ComposerProps[P] }

export function renderComposerQueue({
  view,
  dependencies,
  onSendNow,
  onEditQueued,
  onRemoveQueued,
  onError,
  prompt,
}: ComposerOptions<'dependencies' | 'onSendNow' | 'onEditQueued' | 'onRemoveQueued' | 'onError'> & {
  view: ComposerView
  prompt: RefObject<HTMLTextAreaElement>
}) {
  return view.queue && (view.queue.items.length > 0 || view.queue.error)
    ? createElement(
        'section',
        { className: 'composer-queue', 'aria-label': dependencies.translate('composer.queue.label') },
        createElement(
          'p',
          { className: 'composer-queue-count', 'aria-live': 'polite' },
          dependencies.translate('composer.queue.count', { count: view.queue.items.length }),
        ),
        createElement(
          'ol',
          null,
          view.queue.items.map((item, index) =>
            createElement(
              'li',
              { key: item.itemId, 'data-queue-item': item.itemId, 'data-testid': 'queued-steer' },
              createElement(
                'div',
                { className: 'composer-queue-row' },
                createElement(
                  'span',
                  { className: 'composer-queue-preview', title: item.preview },
                  item.preview || dependencies.translate('composer.queue.attachment'),
                ),
                createElement(
                  'button',
                  {
                    className: 'composer-queue-send',
                    type: 'button',
                    disabled: view.queue?.disabled || !onSendNow || view.queue?.interruptSupported === false,
                    'data-testid': 'queued-steer-interrupt',
                    'aria-label': dependencies.translate('composer.queue.sendAccessible', {
                      index: index + 1,
                    }),
                    title:
                      view.queue?.interruptSupported === false
                        ? view.queue.reason
                        : dependencies.translate('composer.queue.sendTitle'),
                    'aria-busy': view.queue?.sending === item.itemId,
                    onClick: () => {
                      onSendNow?.(item.itemId)
                      prompt.current?.focus()
                    },
                  },
                  dependencies.translate(
                    view.queue?.sending === item.itemId ? 'composer.queue.sending' : 'composer.queue.send',
                  ),
                ),
                onEditQueued
                  ? createElement(QueuedInputEditor, {
                      key: item.itemId,
                      text: item.editText ?? item.preview,
                      disabled: view.queue?.removeDisabled ?? view.queue?.disabled ?? false,
                      save: (text: string) => onEditQueued(item.itemId, text),
                      t: dependencies.translate,
                      onError,
                    })
                  : null,
                onRemoveQueued
                  ? createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'composer-queue-remove',
                        disabled: view.queue?.removeDisabled ?? view.queue?.disabled,
                        'data-testid': 'queued-steer-withdraw',
                        'aria-label': dependencies.translate('composer.queue.removeAccessible', {
                          index: index + 1,
                        }),
                        title: dependencies.translate('composer.queue.removeTitle'),
                        'aria-busy': view.queue?.removing === item.itemId,
                        onClick: () => {
                          onRemoveQueued(item.itemId)
                          prompt.current?.focus()
                        },
                      },
                      dependencies.translate(
                        view.queue?.removing === item.itemId
                          ? 'composer.queue.removing'
                          : 'composer.queue.remove',
                      ),
                    )
                  : null,
              ),
            ),
          ),
        ),
        view.queue.error
          ? createElement('p', { className: 'composer-queue-error', role: 'alert' }, view.queue.error)
          : null,
      )
    : null
}

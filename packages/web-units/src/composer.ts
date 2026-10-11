/*! @license Lucide paperclip, https://github.com/lucide-icons/lucide
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

import { USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import { Button, Icon, SettingsTextArea } from '@agnes/web-ui'
import {
  type ChangeEvent,
  createElement,
  type DragEvent,
  type FormEvent,
  type ForwardedRef,
  Fragment,
  forwardRef,
  type KeyboardEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { useComposerAttachments } from './composer/attachments.js'
import { ChildControlTree } from './composer/child-controls.js'
import {
  type ComposerHandle,
  type ComposerImageBlock,
  type ComposerProps,
  type ComposerView,
  INITIAL_VIEW,
} from './composer/contracts.js'
import type { ComposerAttachment } from './composer/image-files.js'
import { ComposerExtras } from './composer/extras.js'
import { useComposerPickers } from './composer/pickers.js'
import { renderComposerQueue } from './composer/queue.js'
import { ReferencePicker } from './reference-picker.js'

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    references,
    initialDraft = '',
    initialView = INITIAL_VIEW,
    dependencies,
    onCancel,
    onAttachmentsChange,
    prepareUploadSession,
    onDraftChange,
    onError,
    onModelSelect,
    onAuxiliaryRead,
    onAuxiliarySelect,
    onModelSettingsChange,
    onPermissionSelect,
    onSubmit,
    onChildControl,
    onPauseResume,
    onEditQueued,
    onSendNow,
    onRemoveQueued,
    onWorkspace,
    slots,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
) {
  const [view, setView] = useState<ComposerView>(initialView)
  const form = useRef<HTMLFormElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const model = useRef<HTMLButtonElement>(null)
  const permission = useRef<HTMLButtonElement>(null)
  const usage = useRef<HTMLElement>(null)
  const {
    attachments,
    pendingCount,
    fileInput,
    policy,
    imageDisabled,
    imageHint,
    attachmentsRef,
    pendingCountRef,
    uploads,
    clearImageBlocks,
    restoreAttachmentBlocks,
    addFiles,
    removeImage,
    handlePaste,
    handleDrop,
  } = useComposerAttachments({ view, dependencies, prepareUploadSession, onAttachmentsChange, onError })

  useImperativeHandle(
    ref,
    () => ({
      clearImageBlocks,
      focus() {
        prompt.current?.focus()
      },
      getDraft() {
        return prompt.current?.value ?? ''
      },
      getImageBlocks() {
        return attachmentsRef.current
          .filter((block): block is ComposerAttachment & ComposerImageBlock => block.type === 'image')
          .map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      },
      getAttachmentBlocks() {
        return attachmentsRef.current.map((block) =>
          block.type === 'resource_link'
            ? {
                type: block.type,
                uri: block.uri,
                ...(block.name ? { name: block.name } : {}),
                ...(block.mimeType ? { mimeType: block.mimeType } : {}),
              }
            : block.type === 'file'
              ? { type: block.type, data: block.data, mimeType: block.mimeType, name: block.name }
              : { type: block.type, data: block.data, mimeType: block.mimeType },
        )
      },
      restoreAttachmentBlocks,
      hasPendingImages() {
        return pendingCountRef.current > 0 || uploads.pending()
      },
      render(next) {
        flushSync(() => setView(next))
      },
      restoreImageBlocks: restoreAttachmentBlocks,
      resize() {
        if (prompt.current) dependencies.resize(prompt.current)
      },
      setDraft(value) {
        if (!prompt.current || prompt.current.value === value) return
        prompt.current.value = value
        dependencies.resize(prompt.current)
      },
    }),
    [
      dependencies.resize,
      clearImageBlocks,
      restoreAttachmentBlocks,
      attachmentsRef,
      pendingCountRef,
      uploads,
    ],
  )

  useComposerPickers({
    dependencies,
    onError,
    onModelSelect,
    onAuxiliaryRead,
    onAuxiliarySelect,
    onModelSettingsChange,
    onPermissionSelect,
    view,
    model,
    permission,
    usage,
  })

  // 队列排在输入卡之外、它的上方。排队的消息和正在写的草稿是两件事，同处一张卡里会被读成
  // 一件事。卡片样式（含必须挂在区域钩子上的 backdrop-filter）仍留在
  // [data-agnes-region="composer"]，队列只是它的前一个兄弟节点。
  const queueSection = renderComposerQueue({
    view,
    dependencies,
    onSendNow,
    onEditQueued,
    onRemoveQueued,
    onError,
    prompt,
  })
  return createElement(
    Fragment,
    null,
    view.children?.length && onChildControl
      ? createElement(ChildControlTree, {
          nodes: view.children,
          disabled: view.childrenDisabled === true,
          control: onChildControl,
          t: dependencies.translate,
        })
      : null,
    queueSection,
    createElement(
      'form',
      {
        ref: form,
        id: 'composer',
        'data-agnes-region': 'composer',
        'data-agnes-region-owner': 'builtin',
        'data-agnes-region-unit': 'composer',
        onDragOver: (event: DragEvent<HTMLFormElement>) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        },
        onDrop: handleDrop,
        onSubmit: (event: SubmitEvent) => {
          event.preventDefault()
          onSubmit()
        },
      },
      createElement(ReferencePicker, {
        textarea: prompt,
        ...(references ? { adapter: references } : {}),
        t: dependencies.translate,
        disabled: imageDisabled,
      }),
      slots?.overlay,
      // 待发图片排在输入文字上方：文字行数增长时图片不会被顶出视野。空态由 CSS 收掉
      // （style.css 的 :has 规则），这里不额外做条件渲染。
      createElement(
        'div',
        { className: 'composer-image-attachments' },
        createElement(
          'div',
          {
            className: 'composer-image-preview-list',
            'aria-label': imageHint,
            'aria-live': 'polite',
          },
          ...uploads.chips,
          ...attachments.map((attachment, index) =>
            createElement(
              'figure',
              {
                className: attachment.type === 'image' ? 'composer-image-preview' : 'composer-file-preview',
                key: attachment.id,
                'data-testid': 'attachment-ready',
              },
              attachment.type === 'image'
                ? createElement('img', {
                    src: attachment.previewUrl,
                    alt: dependencies.translate('composer.image.alt', { index: index + 1 }),
                  })
                : createElement('span', { title: attachment.name }, attachment.name),
              attachment.type !== 'image'
                ? createElement('small', null, `${(attachment.size / 1024).toFixed(1)} KiB`)
                : null,
              createElement(
                Button,
                {
                  htmlType: 'button',
                  'data-remove-image': 'true',
                  'data-testid': 'attachment-remove',
                  'aria-label': dependencies.translate('composer.attachment.remove', { index: index + 1 }),
                  disabled: view.sending,
                  onClick: () => removeImage(attachment.id),
                },
                '×',
              ),
            ),
          ),
          pendingCount > 0
            ? createElement(
                'span',
                { className: 'composer-image-pending', role: 'status' },
                dependencies.translate('composer.image.reading'),
              )
            : undefined,
        ),
      ),
      createElement(
        'div',
        { className: 'composer-writing' },
        createElement(
          'label',
          { className: 'visually-hidden', htmlFor: 'prompt' },
          dependencies.translate('composer.input.label'),
        ),
        createElement(SettingsTextArea, {
          presentation: 'plain',
          ref: prompt,
          id: 'prompt',
          'data-agnes-region': 'composer-input',
          rows: 1,
          'aria-describedby': 'composer-hint',
          disabled: view.input.disabled,
          placeholder: view.input.placeholder,
          defaultValue: initialDraft,
          onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (
              !dependencies.isSubmitShortcut({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
              })
            )
              return
            event.preventDefault()
            form.current?.requestSubmit()
          },
          onInput: (event: FormEvent<HTMLTextAreaElement>) => onDraftChange(event.currentTarget.value),
          onPaste: handlePaste,
        }),
        createElement('p', { id: 'composer-hint', 'data-kind': view.hint.kind }, view.hint.text),
        slots?.attachments,
      ),
      createElement(
        'div',
        { className: 'composer-controls' },
        createElement(
          ComposerExtras,
          { label: dependencies.translate('composer.extra.title') },
          slots?.left,
          slots?.right,
          slots?.plan,
        ),
        createElement(
          Button,
          {
            id: 'composer-workspace',
            className: 'composer-workspace',
            appearance: 'ghost',
            hidden: !(view.workspace.visible ?? !view.hasSession),
            htmlType: 'button',
            'aria-haspopup': 'dialog',
            title: view.workspace.title,
            disabled: view.workspace.disabled,
            onClick: onWorkspace,
          },
          createElement(Icon, { name: 'folder' }),
          createElement('span', { 'data-workspace-label': true }, view.workspace.label),
          createElement(
            'svg',
            {
              className: 'icon model-chevron',
              'data-agnes-region': 'icon',
              viewBox: '0 0 24 24',
              'aria-hidden': true,
            },
            createElement('path', { d: 'm6 9 6 6 6-6' }),
          ),
        ),
        slots?.permission,
        createElement(
          Button,
          {
            ref: permission,
            id: 'composer-permission',
            className: 'composer-permission',
            appearance: 'ghost',
            'data-permission': view.permission.selected ?? 'unknown',
            htmlType: 'button',
            'aria-haspopup': 'listbox',
            'aria-expanded': false,
            'aria-label': dependencies.translate('composer.permission.accessible'),
            title: dependencies.translate('composer.permission.workspace'),
            disabled: view.permission.disabled,
          },
          createElement(Icon, { name: 'shield' }),
          createElement(
            'span',
            { 'data-permission-label': true },
            dependencies.translate('composer.permission.workspace'),
          ),
          createElement(
            'svg',
            {
              className: 'icon model-chevron',
              'data-agnes-region': 'icon',
              viewBox: '0 0 24 24',
              'aria-hidden': true,
            },
            createElement('path', { d: 'm6 9 6 6 6-6' }),
          ),
        ),
        slots?.model,
        createElement(
          'div',
          { className: 'model-field' },
          createElement(
            Button,
            {
              ref: model,
              id: 'model',
              htmlType: 'button',
              'aria-haspopup': 'listbox',
              'aria-expanded': false,
              'aria-label': view.model.accessibleName,
            },
            createElement('span', { 'data-model-label': true }, view.model.label),
            createElement(
              'svg',
              {
                className: 'icon model-chevron',
                'data-agnes-region': 'icon',
                viewBox: '0 0 24 24',
                'aria-hidden': true,
              },
              createElement('path', { d: 'm6 9 6 6 6-6' }),
            ),
          ),
        ),
        createElement(
          'section',
          {
            ref: usage,
            id: 'session-usage',
            'aria-label': dependencies.translate('composer.usage.label'),
            hidden: !view.usage || view.usage.context.tokens / view.usage.context.window < 0.6,
          },
          dependencies.UsagePanel
            ? createElement(dependencies.UsagePanel, {
                usage: view.usage,
                connected: view.connected,
                t: dependencies.translate,
              })
            : undefined,
        ),
        view.controls
          ? createElement(
              Button,
              {
                htmlType: 'button',
                'data-testid': 'composer-pause-resume',
                hidden: view.cancel.hidden,
                disabled: view.controls.disabled || view.controls.pending || !view.controls.pauseSupported,
                title: view.controls.pauseSupported
                  ? dependencies.translate('composer.control.pauseTitle')
                  : view.controls.reason,
                'aria-pressed': view.controls.paused,
                onClick: onPauseResume,
              },
              dependencies.translate(
                view.controls.paused ? 'composer.control.resume' : 'composer.control.pause',
              ),
            )
          : null,
        view.controls?.paused
          ? createElement(
              'span',
              { role: 'status', 'data-testid': 'composer-paused' },
              dependencies.translate('composer.control.paused'),
            )
          : null,
        createElement(
          Button,
          {
            'data-testid': 'composer-cancel',
            id: 'cancel',
            appearance: 'ghost',
            size: 'small',
            htmlType: 'button',
            hidden: view.cancel.hidden,
            disabled: view.cancel.disabled,
            onClick: onCancel,
          },
          view.cancel.label,
        ),
        createElement('input', {
          ref: fileInput,
          type: 'file',
          'data-testid': 'attachment-file-input',
          hidden: true,
          multiple: true,
          'aria-label': dependencies.translate('composer.attachment.add'),
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            void addFiles(files)
          },
        }),
        createElement('span', { id: 'composer-image-hint', className: 'visually-hidden' }, imageHint),
        createElement(
          Button,
          {
            id: 'composer-attach',
            htmlType: 'button',
            appearance: 'ghost',
            size: 'small',
            'aria-label': dependencies.translate('composer.attachment.add'),
            'aria-describedby': 'composer-image-hint',
            'aria-disabled':
              imageDisabled ||
              attachments.length + pendingCount + uploads.count() >= USER_MESSAGE_ATTACHMENT_LIMITS.maxCount,
            title: imageHint,
            onClick: () => {
              if (imageDisabled) {
                if (!policy.supported) onError(new Error(imageHint))
                return
              }
              if (
                attachments.length + pendingCount + uploads.count() >=
                USER_MESSAGE_ATTACHMENT_LIMITS.maxCount
              ) {
                onError(
                  new Error(
                    dependencies.translate('composer.attachment.tooMany', {
                      count: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount,
                    }),
                  ),
                )
                return
              }
              fileInput.current?.click()
            },
          },
          createElement(Icon, { name: 'plus' }),
        ),
        createElement(
          Button,
          {
            id: 'send',
            appearance: 'primary',
            htmlType: 'submit',
            disabled: view.send.disabled,
            'data-mode': view.send.mode,
            'aria-label': view.send.label,
            title: view.send.title,
          },
          createElement('span', null, view.send.label),
          createElement(
            'svg',
            { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
            createElement('path', { d: 'M12 19V5M6.5 10.5 12 5l5.5 5.5' }),
          ),
        ),
        slots?.dock,
      ),
    ),
  )
})

export type {
  ComposerAttachmentBlock,
  ComposerDependencies,
  ComposerHandle,
  ComposerImageBlock,
  ComposerRegionOptions,
  ComposerSlots,
  ComposerView,
  ModelPicker,
  ModelPickerOption,
  ModelPickerSettings,
  ModelPickerState,
  PermissionMode,
  PermissionPicker,
  PermissionPickerState,
} from './composer/contracts.js'
export { downscaleImageFile } from './composer/image-files.js'

import { USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import { Button, Icon, SettingsInput, SettingsTextArea } from '@agnes/web-ui'
import {
  type ChangeEvent,
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
import { ComposerExtras } from './composer/extras.js'
import type { ComposerAttachment } from './composer/image-files.js'
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
  return (
    <Fragment>
      {view.children?.length && onChildControl ? (
        <ChildControlTree
          nodes={view.children}
          disabled={view.childrenDisabled === true}
          control={onChildControl}
          t={dependencies.translate}
        />
      ) : null}
      {queueSection}
      <form
        ref={form}
        id="composer"
        data-agnes-region="composer"
        data-agnes-region-owner="builtin"
        data-agnes-region-unit="composer"
        onDragOver={(event: DragEvent<HTMLFormElement>) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={handleDrop}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <ReferencePicker
          textarea={prompt}
          {...(references ? { adapter: references } : {})}
          t={dependencies.translate}
          disabled={imageDisabled}
        />
        {slots?.overlay}
        <div className="composer-image-attachments">
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: retain the attachment live region label. */}
          <div className="composer-image-preview-list" aria-label={imageHint} aria-live="polite">
            {uploads.chips}
            {attachments.map((attachment, index) => (
              <figure
                className={attachment.type === 'image' ? 'composer-image-preview' : 'composer-file-preview'}
                key={attachment.id}
                data-testid="attachment-ready"
              >
                {attachment.type === 'image' ? (
                  <img
                    src={attachment.previewUrl}
                    alt={dependencies.translate('composer.image.alt', { index: index + 1 })}
                  />
                ) : (
                  <span title={attachment.name}>{attachment.name}</span>
                )}
                {attachment.type !== 'image' ? (
                  <small>{`${(attachment.size / 1024).toFixed(1)} KiB`}</small>
                ) : null}
                <Button
                  htmlType="button"
                  data-remove-image="true"
                  data-testid="attachment-remove"
                  aria-label={dependencies.translate('composer.attachment.remove', {
                    index: index + 1,
                  })}
                  disabled={view.sending}
                  onClick={() => removeImage(attachment.id)}
                >
                  {'×'}
                </Button>
              </figure>
            ))}
            {pendingCount > 0 ? (
              <span className="composer-image-pending" role="status">
                {dependencies.translate('composer.image.reading')}
              </span>
            ) : undefined}
          </div>
        </div>
        <div className="composer-writing">
          <label className="visually-hidden" htmlFor="prompt">
            {dependencies.translate('composer.input.label')}
          </label>
          <SettingsTextArea
            presentation="plain"
            ref={prompt}
            id="prompt"
            data-agnes-region="composer-input"
            rows={1}
            aria-describedby="composer-hint"
            disabled={view.input.disabled}
            placeholder={view.input.placeholder}
            defaultValue={initialDraft}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
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
            }}
            onInput={(event: FormEvent<HTMLTextAreaElement>) => onDraftChange(event.currentTarget.value)}
            onPaste={handlePaste}
          />
          <p id="composer-hint" data-kind={view.hint.kind}>
            {view.hint.text}
          </p>
          {slots?.attachments}
        </div>
        <div className="composer-controls">
          <ComposerExtras label={dependencies.translate('composer.extra.title')}>
            {slots?.left}
            {slots?.right}
            {slots?.plan}
          </ComposerExtras>
          <Button
            id="composer-workspace"
            className="composer-workspace"
            appearance="ghost"
            hidden={!(view.workspace.visible ?? !view.hasSession)}
            htmlType="button"
            aria-haspopup="dialog"
            title={view.workspace.title}
            disabled={view.workspace.disabled}
            onClick={onWorkspace}
          >
            <Icon name="folder" />
            <span data-workspace-label={true}>{view.workspace.label}</span>
            <Icon name="chevron-down" className="model-chevron" />
          </Button>
          {slots?.permission}
          <Button
            ref={permission}
            id="composer-permission"
            className="composer-permission"
            appearance="ghost"
            data-permission={view.permission.selected ?? 'unknown'}
            htmlType="button"
            aria-haspopup="listbox"
            aria-expanded={false}
            aria-label={dependencies.translate('composer.permission.accessible')}
            title={dependencies.translate('composer.permission.workspace')}
            disabled={view.permission.disabled}
          >
            <Icon name="shield" />
            <span data-permission-label={true}>
              {dependencies.translate('composer.permission.workspace')}
            </span>
            <Icon name="chevron-down" className="model-chevron" />
          </Button>
          {slots?.model}
          <div className="model-field">
            <Button
              ref={model}
              id="model"
              htmlType="button"
              aria-haspopup="listbox"
              aria-expanded={false}
              aria-label={view.model.accessibleName}
            >
              <span data-model-label={true}>{view.model.label}</span>
              <Icon name="chevron-down" className="model-chevron" />
            </Button>
          </div>
          <section
            ref={usage}
            id="session-usage"
            aria-label={dependencies.translate('composer.usage.label')}
            hidden={
              !view.usage ||
              !(view.usage.context.window > 0 && view.usage.context.tokens / view.usage.context.window >= 0.6)
            }
          >
            {dependencies.UsagePanel ? (
              <dependencies.UsagePanel
                usage={view.usage}
                connected={view.connected}
                t={dependencies.translate}
              />
            ) : undefined}
          </section>
          {view.controls ? (
            <Button
              htmlType="button"
              data-testid="composer-pause-resume"
              hidden={view.cancel.hidden}
              disabled={view.controls.disabled || view.controls.pending || !view.controls.pauseSupported}
              title={
                view.controls.pauseSupported
                  ? dependencies.translate('composer.control.pauseTitle')
                  : view.controls.reason
              }
              aria-pressed={view.controls.paused}
              onClick={onPauseResume}
            >
              {dependencies.translate(
                view.controls.paused ? 'composer.control.resume' : 'composer.control.pause',
              )}
            </Button>
          ) : null}
          {view.controls?.paused ? (
            <span role="status" data-testid="composer-paused">
              {dependencies.translate('composer.control.paused')}
            </span>
          ) : null}
          <Button
            data-testid="composer-cancel"
            id="cancel"
            appearance="ghost"
            size="small"
            htmlType="button"
            hidden={view.cancel.hidden}
            disabled={view.cancel.disabled}
            onClick={onCancel}
          >
            {view.cancel.label}
          </Button>
          <SettingsInput
            ref={fileInput}
            type="file"
            data-testid="attachment-file-input"
            hidden={true}
            multiple={true}
            aria-label={dependencies.translate('composer.attachment.add')}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              void addFiles(files)
            }}
          />
          <span id="composer-image-hint" className="visually-hidden">
            {imageHint}
          </span>
          <Button
            id="composer-attach"
            htmlType="button"
            appearance="ghost"
            size="small"
            aria-label={dependencies.translate('composer.attachment.add')}
            aria-describedby="composer-image-hint"
            aria-disabled={
              imageDisabled ||
              attachments.length + pendingCount + uploads.count() >= USER_MESSAGE_ATTACHMENT_LIMITS.maxCount
            }
            title={imageHint}
            onClick={() => {
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
            }}
          >
            <Icon name="plus" />
          </Button>
          <Button
            id="send"
            appearance="primary"
            htmlType="submit"
            disabled={view.send.disabled}
            data-mode={view.send.mode}
            aria-label={view.send.label}
            title={view.send.title}
          >
            <span>{view.send.label}</span>
            <Icon name="arrow-up" />
          </Button>
          {slots?.dock}
        </div>
      </form>
    </Fragment>
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

import { USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import { Button, Icon, Kbd, Menu, SettingsInput } from '@agnes/web-ui'
import { Sender, type SenderInputAttributes, type SenderRef, XProvider } from '@agnes/web-ui/x'
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ForwardedRef,
  Fragment,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { ComposerAttachmentList } from './composer/attachment-list.js'
import { useComposerAttachments } from './composer/attachments.js'
import { ChildControlTree } from './composer/child-controls.js'
import {
  type ComposerHandle,
  type ComposerImageBlock,
  type ComposerProps,
  type ComposerView,
  INITIAL_VIEW,
  pickerState,
} from './composer/contracts.js'
import { ComposerExtras } from './composer/extras.js'
import type { ComposerAttachment } from './composer/image-files.js'
import { renderComposerQueue } from './composer/queue.js'
import { ReferencePicker, referenceStart } from './reference-picker.js'

const INPUT_ATTRIBUTES: SenderInputAttributes = {
  id: 'prompt',
  'data-agnes-region': 'composer-input',
  'aria-describedby': 'composer-hint',
}
const AUTO_SIZE = { minRows: 2, maxRows: 8 }
const SENDER_CLASSES = { content: 'composer-content', footer: 'composer-footer' }

/**
 * The writing card and the quiet row under it. The card holds the draft, its attachments and the
 * per-message controls (add, model, send/stop); the row holds what applies to the whole session
 * (Agent, workspace, context usage, approval mode). The host keeps every fact and command.
 */
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
  const [draft, setDraft] = useState(initialDraft)
  // The host reads the draft synchronously (set, then submit) before React commits the state.
  const draftRef = useRef(initialDraft)
  const form = useRef<HTMLFormElement>(null)
  const sender = useRef<SenderRef>(null)
  const prompt = useRef<HTMLTextAreaElement | null>(null)
  const t = dependencies.translate
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

  const pendingCaret = useRef<number>()
  const changeDraft = (value: string): void => {
    draftRef.current = value
    setDraft(value)
    onDraftChange(value)
  }
  /** Programmatic edits (pasted text, a chosen or started reference) go through the same state as typing. */
  const editDraft = (start: number, end: number, text: string): void => {
    pendingCaret.current = start + text.length
    changeDraft(draftRef.current.slice(0, start) + text + draftRef.current.slice(end))
  }

  // The reference picker and the queue address the native textarea; publish it before their effects run.
  useLayoutEffect(() => {
    const input = (sender.current?.inputElement as HTMLTextAreaElement | undefined) ?? null
    prompt.current = input
    const caret = pendingCaret.current
    if (caret === undefined || !input || input.value !== draftRef.current) return
    pendingCaret.current = undefined
    input.focus()
    input.setSelectionRange(caret, caret)
    // React already holds this value; the event only tells the reference picker the caret moved.
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  useImperativeHandle(
    ref,
    () => ({
      clearImageBlocks,
      focus() {
        sender.current?.focus()
      },
      getDraft() {
        return draftRef.current
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
      setDraft(value) {
        if (draftRef.current === value) return
        draftRef.current = value
        setDraft(value)
      },
    }),
    [clearImageBlocks, restoreAttachmentBlocks, attachmentsRef, pendingCountRef, uploads],
  )

  const attachmentCount = attachments.length + pendingCount + uploads.count()
  const attachmentsFull = attachmentCount >= USER_MESSAGE_ATTACHMENT_LIMITS.maxCount
  const chooseFiles = (): void => {
    if (imageDisabled) {
      if (!policy.supported) onError(new Error(imageHint))
      return
    }
    if (attachmentsFull) {
      onError(new Error(t('composer.attachment.tooMany', { count: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount })))
      return
    }
    fileInput.current?.click()
  }
  const addButton = (
    <Button
      id="composer-attach"
      htmlType="button"
      appearance="ghost"
      size="small"
      aria-label={t(references ? 'composer.add.label' : 'composer.attachment.add')}
      aria-describedby="composer-image-hint"
      aria-disabled={imageDisabled || attachmentsFull}
      title={references ? t('composer.add.label') : imageHint}
      {...(references ? {} : { onClick: chooseFiles })}
    >
      <Icon name="plus" size={18} />
    </Button>
  )

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
  const showUsage = Boolean(view.usage && view.usage.context.window > 0)
  return (
    <Fragment>
      {view.children?.length && onChildControl ? (
        <ChildControlTree
          nodes={view.children}
          disabled={view.childrenDisabled === true}
          control={onChildControl}
          t={t}
        />
      ) : null}
      {queueSection}
      <form
        ref={form}
        id="composer"
        data-agnes-region="composer"
        data-agnes-region-owner="builtin"
        data-agnes-region-unit="composer"
        data-busy={view.send.mode === 'busy'}
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
          edit={editDraft}
          {...(references ? { adapter: references } : {})}
          t={t}
          disabled={imageDisabled}
        />
        {slots?.overlay}
        <label className="visually-hidden" htmlFor="prompt">
          {t('composer.input.label')}
        </label>
        <XProvider>
          <Sender
            ref={sender}
            suffix={false}
            classNames={SENDER_CLASSES}
            inputAttributes={INPUT_ATTRIBUTES}
            value={draft}
            disabled={view.input.disabled}
            placeholder={view.input.placeholder}
            autoSize={AUTO_SIZE}
            onChange={changeDraft}
            onKeyDown={(event) => {
              const native = event.nativeEvent as KeyboardEvent
              if (
                dependencies.isSubmitShortcut({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: native.isComposing,
                  keyCode: event.keyCode,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                })
              ) {
                event.preventDefault()
                form.current?.requestSubmit()
              }
              // One keyboard contract: the host's shortcut decides, never Sender's own Enter rule.
              return false
            }}
            onPaste={(event) =>
              handlePaste(event, (text) => {
                const input = prompt.current
                editDraft(input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length, text)
              })
            }
            header={
              <div className="composer-writing">
                <ComposerAttachmentList
                  attachments={attachments}
                  uploads={uploads.chips}
                  pendingCount={pendingCount}
                  hint={imageHint}
                  disabled={view.sending}
                  onRemove={removeImage}
                  t={t}
                />
                {slots?.attachments}
              </div>
            }
            footer={
              <div className="composer-controls">
                {references ? (
                  <Menu
                    label={t('composer.add.label')}
                    trigger={addButton}
                    items={[
                      {
                        id: 'file',
                        label: t('composer.add.file'),
                        testId: 'composer-add-file',
                        onSelect: chooseFiles,
                      },
                      {
                        id: 'reference',
                        label: t('composer.add.reference'),
                        testId: 'composer-add-reference',
                        disabled: imageDisabled,
                        onSelect: () => {
                          if (!prompt.current) return
                          const { start, end, text } = referenceStart(prompt.current)
                          editDraft(start, end, text)
                        },
                      },
                    ]}
                  />
                ) : (
                  addButton
                )}
                <p id="composer-hint" data-kind={view.hint.kind}>
                  {view.hint.text}
                </p>
                {view.hint.kind === 'shortcut' ? (
                  <span className="composer-shortcuts" aria-hidden="true">
                    <Kbd>↵</Kbd>
                    {t('composer.shortcut.send')}
                    <Kbd>⇧</Kbd>
                    <Kbd>↵</Kbd>
                    {t('composer.shortcut.newline')}
                  </span>
                ) : null}
                {slots?.model}
                <div className="model-field">
                  <dependencies.ModelPicker
                    state={pickerState(view)}
                    onError={onError}
                    onSelect={onModelSelect}
                    {...(onAuxiliaryRead ? { onAuxiliaryRead } : {})}
                    {...(onAuxiliarySelect ? { onAuxiliarySelect } : {})}
                    {...(onModelSettingsChange ? { onSettingsChange: onModelSettingsChange } : {})}
                  />
                </div>
                {view.controls ? (
                  <Button
                    htmlType="button"
                    appearance="ghost"
                    size="small"
                    data-testid="composer-pause-resume"
                    hidden={view.cancel.hidden}
                    disabled={
                      view.controls.disabled || view.controls.pending || !view.controls.pauseSupported
                    }
                    title={
                      view.controls.pauseSupported ? t('composer.control.pauseTitle') : view.controls.reason
                    }
                    aria-pressed={view.controls.paused}
                    onClick={onPauseResume}
                  >
                    {t(view.controls.paused ? 'composer.control.resume' : 'composer.control.pause')}
                  </Button>
                ) : null}
                {view.controls?.paused ? (
                  <span role="status" data-testid="composer-paused">
                    {t('composer.control.paused')}
                  </span>
                ) : null}
                <Button
                  data-testid="composer-cancel"
                  id="cancel"
                  appearance="secondary"
                  htmlType="button"
                  hidden={view.cancel.hidden}
                  disabled={view.cancel.disabled}
                  aria-label={view.cancel.label}
                  title={view.cancel.label}
                  onClick={onCancel}
                >
                  <span className="visually-hidden">{view.cancel.label}</span>
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
                  <span className="visually-hidden">{view.send.label}</span>
                  <Icon name="arrow-up" size={18} />
                </Button>
              </div>
            }
          />
        </XProvider>
        <SettingsInput
          ref={fileInput}
          type="file"
          data-testid="attachment-file-input"
          hidden={true}
          multiple={true}
          aria-label={t('composer.attachment.add')}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            void addFiles(files)
          }}
        />
        <span id="composer-image-hint" className="visually-hidden">
          {imageHint}
        </span>
      </form>
      <div className="composer-meta" data-agnes-composer-meta={true}>
        <div className="composer-meta-start">
          <ComposerExtras label={t('composer.extra.title')}>
            {slots?.left}
            {slots?.right}
            {slots?.plan}
          </ComposerExtras>
          <Button
            id="composer-workspace"
            className="composer-workspace"
            appearance="ghost"
            size="small"
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
        </div>
        <div className="composer-meta-end">
          <section id="session-usage" aria-label={t('composer.usage.label')} hidden={!showUsage}>
            <dependencies.UsagePanel usage={view.usage} connected={view.connected} t={t} />
          </section>
          {slots?.permission}
          <dependencies.PermissionPicker
            state={view.permission}
            onError={onError}
            onSelect={onPermissionSelect}
          />
          {slots?.dock}
        </div>
      </div>
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
  ModelPickerOption,
  ModelPickerProps,
  ModelPickerSettings,
  ModelPickerState,
  PermissionMode,
  PermissionPickerProps,
  PermissionPickerState,
} from './composer/contracts.js'
export { downscaleImageFile } from './composer/image-files.js'

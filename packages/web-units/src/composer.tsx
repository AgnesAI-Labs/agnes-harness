import { USER_MESSAGE_ATTACHMENT_LIMITS } from '@agnes/protocol-validation'
import { Button, Icon, SettingsInput, Tooltip } from '@agnes/web-ui'
import { Sender, type SenderInputAttributes, type SenderRef, XProvider } from '@agnes/web-ui/x'
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ForwardedRef,
  Fragment,
  forwardRef,
  useEffect,
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
import { FileMentionLayer, mentionTokens, useFileMentions } from './composer/file-mentions.js'
import { useComposerHint } from './composer/hint.js'
import type { ComposerAttachment } from './composer/image-files.js'
import { renderComposerQueue } from './composer/queue.js'
import { ReferencePicker } from './reference-picker.js'

const INPUT_ATTRIBUTES: SenderInputAttributes = {
  id: 'prompt',
  'data-agnes-region': 'composer-input',
  'aria-describedby': 'composer-hint composer-suggestion',
}
const AUTO_SIZE = { minRows: 2, maxRows: 8 }
// Native content sizing follows CSS font/viewport changes without stale pixel measurements.
const NATIVE_INPUT_STYLES = {
  input: {
    fieldSizing: 'content',
    width: '100%',
    height: 'auto',
    minHeight: `${AUTO_SIZE.minRows}lh`,
    maxHeight: `${AUTO_SIZE.maxRows}lh`,
    overflowY: 'auto',
  },
} as const
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
    examplePrompts = [],
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
    onPromoteQueued,
    onRemoveQueued,
    onWorkspace,
    onWorkspaceSelect,
    onWorkspaceRemove,
    slots,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
) {
  const nativeSizing =
    typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content') && CSS.supports('min-height', '1lh')
  const [view, setView] = useState<ComposerView>(initialView)
  const [draft, setDraft] = useState(initialDraft)
  // The host reads the draft synchronously (set, then submit) before React commits the state.
  const draftRef = useRef(initialDraft)
  const form = useRef<HTMLFormElement>(null)
  // Set by ⌘/Ctrl+Enter for the submit it starts: send as guidance instead of queueing.
  const submitAsSteer = useRef(false)
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

  const hasAttachments = attachments.length + pendingCount + uploads.chips.length > 0
  const example = useComposerHint(
    examplePrompts,
    view.input.exampleHint === true,
    !view.input.disabled &&
      !view.loading &&
      !view.sending &&
      !view.stopping &&
      view.send.mode === 'idle' &&
      !draft &&
      !hasAttachments,
    view.input.hintScope,
    dependencies.loadHint,
    dependencies.subscribeHintInvalidation,
  )
  // What React last rendered into the textarea; a host edit is pending while it differs from draftRef.
  const renderedDraft = useRef(initialDraft)
  const pendingCaret = useRef<number>()
  const changeDraft = (value: string): void => {
    if (value === draftRef.current) return
    draftRef.current = value
    setDraft(value)
    onDraftChange(value)
  }
  const adoptDraft = useRef(changeDraft)
  adoptDraft.current = changeDraft
  /** Programmatic edits (pasted text, a chosen or started reference) go through the same state as typing. */
  const editDraft = (start: number, end: number, text: string): void => {
    pendingCaret.current = start + text.length
    changeDraft(draftRef.current.slice(0, start) + text + draftRef.current.slice(end))
  }
  // The suggestion belongs to the page, not to the textarea: while it is on screen, Tab adopts it
  // even when the caret is elsewhere. Only a focused editable field or an open dialog keeps Tab.
  const adoptSuggestion = useRef<(() => void) | undefined>(undefined)
  adoptSuggestion.current = example.adoptText
    ? () => {
        editDraft(0, 0, example.adoptText)
        prompt.current?.focus()
      }
    : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: the listener reads the latest draft and attachments through refs.
  useEffect(() => {
    if (!example.visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      const adopt = adoptSuggestion.current
      if (!adopt || event.key !== 'Tab' || event.defaultPrevented) return
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)))
        return
      if (active?.closest('[role="dialog"], .ant-modal-wrap')) return
      // A modal anywhere on the page owns Tab, even when focus sits on the body behind it.
      if (document.querySelector('dialog[open], [role="dialog"], .ant-modal-wrap')) return
      if (currentDraft() || attachmentsRef.current.length || pendingCountRef.current || uploads.count())
        return
      event.preventDefault()
      adopt()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [example.visible])
  const mentions = useFileMentions({ prompt, draftRef, editDraft })
  const mentionTokensInDraft = mentionTokens(draft, mentions.mentions)
  const currentDraft = () =>
    draftRef.current !== renderedDraft.current
      ? draftRef.current
      : (prompt.current?.value ?? draftRef.current)
  /** An `@` result names a file or folder of the workspace by its relative path. */
  const mentionRelative = (relative: string, directory: boolean, range?: { start: number; end: number }) => {
    const root = view.workspace.root
    if (!root) return false
    const name = relative.split('/').filter(Boolean).at(-1) ?? relative
    mentions.insert({ path: `${root.replace(/[\\/]+$/u, '')}/${relative}`, name, directory }, range)
    return true
  }

  // The reference picker and the queue address the native textarea; publish it before their effects run.
  useLayoutEffect(() => {
    const input = (sender.current?.inputElement as HTMLTextAreaElement | undefined) ?? null
    prompt.current = input
    renderedDraft.current = draft
    const caret = pendingCaret.current
    if (caret === undefined || !input || input.value !== draftRef.current) return
    pendingCaret.current = undefined
    input.focus()
    input.setSelectionRange(caret, caret)
    // React already holds this value; the event only tells the reference picker the caret moved.
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  // A scripted write (`textarea.value = …` followed by an input event, as text expanders and
  // automation do) bypasses React's change tracking. Adopt it so the draft is what the user sees.
  useEffect(() => {
    const input = prompt.current
    if (!input) return
    const adopt = () => adoptDraft.current(input.value)
    input.addEventListener('input', adopt)
    return () => input.removeEventListener('input', adopt)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the handle reads the latest draft through refs.
  useImperativeHandle(
    ref,
    () => ({
      clearImageBlocks() {
        clearImageBlocks()
        mentions.clear()
      },
      mention(mention) {
        mentions.insert(mention)
      },
      focus() {
        sender.current?.focus()
      },
      getDraft() {
        // A host edit that has not rendered yet wins; otherwise the textarea is what the user sees.
        if (draftRef.current !== renderedDraft.current) return draftRef.current
        return prompt.current?.value ?? draftRef.current
      },
      getImageBlocks() {
        return attachmentsRef.current
          .filter((block): block is ComposerAttachment & ComposerImageBlock => block.type === 'image')
          .map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      },
      getAttachmentBlocks() {
        const linked = mentions.blocks(currentDraft())
        return [
          ...attachmentsRef.current.map((block) =>
            block.type === 'resource_link'
              ? {
                  type: block.type,
                  uri: block.uri,
                  ...(block.attachment ? { attachment: structuredClone(block.attachment) } : {}),
                  ...(block.name ? { name: block.name } : {}),
                  ...(block.mimeType ? { mimeType: block.mimeType } : {}),
                }
              : block.type === 'file'
                ? { type: block.type, data: block.data, mimeType: block.mimeType, name: block.name }
                : { type: block.type, data: block.data, mimeType: block.mimeType },
          ),
          // Files and folders named in the text travel as links to their real paths.
          ...linked,
        ]
      },
      restoreAttachmentBlocks(restored) {
        restoreAttachmentBlocks(mentions.restore(restored))
      },
      hasPendingImages() {
        return pendingCountRef.current > 0 || uploads.pending()
      },
      render(next) {
        flushSync(() => setView(next))
      },
      restoreImageBlocks(restored) {
        restoreAttachmentBlocks(mentions.restore(restored))
      },
      setDraft(value) {
        if (draftRef.current !== value) {
          draftRef.current = value
          setDraft(value)
          return
        }
        // A scripted write React never saw is still on screen; bring the textarea back to the state.
        const input = prompt.current
        if (input && input.value !== value) input.value = value
      },
    }),
    [clearImageBlocks, restoreAttachmentBlocks, attachmentsRef, pendingCountRef, uploads, mentions],
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
    <Tooltip title={imageHint}>
      <Button
        id="composer-attach"
        htmlType="button"
        appearance="ghost"
        size="small"
        aria-label={t('composer.attachment.add')}
        aria-describedby="composer-image-hint"
        aria-disabled={imageDisabled || attachmentsFull}
        onClick={chooseFiles}
      >
        <Icon name="plus" size={18} />
      </Button>
    </Tooltip>
  )

  // 队列排在输入卡之外、它的上方。排队的消息和正在写的草稿是两件事，同处一张卡里会被读成
  // 一件事。卡片样式（含必须挂在区域钩子上的 backdrop-filter）仍留在
  // [data-agnes-region="composer"]，队列只是它的前一个兄弟节点。
  const queueSection = renderComposerQueue({
    view,
    dependencies,
    onSendNow,
    onPromoteQueued,
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
      {view.controls?.paused ? (
        <p className="composer-paused" role="status" data-testid="composer-paused">
          <Icon name="pause" size={16} />
          <span>
            {view.queue?.items.length
              ? t('composer.control.pausedQueued', { count: view.queue.items.length })
              : t('composer.control.paused')}
          </span>
        </p>
      ) : null}
      {queueSection}
      <form
        ref={form}
        id="composer"
        data-agnes-region="composer"
        data-agnes-region-owner="builtin"
        data-agnes-region-unit="composer"
        data-example-hint={example.visible || undefined}
        data-busy={view.send.mode === 'busy'}
        onDragOver={(event: DragEvent<HTMLFormElement>) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={handleDrop}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const steer = submitAsSteer.current
          submitAsSteer.current = false
          if (view.readOnly || view.loading || view.send.disabled) return
          onSubmit(steer ? { steer } : undefined)
        }}
      >
        <ReferencePicker
          textarea={prompt}
          edit={editDraft}
          {...(references ? { adapter: references } : {})}
          chooseFile={(id, directory, range) => mentionRelative(id, directory, range)}
          isChip={(index) =>
            mentionTokens(draftRef.current, mentions.mentions).some((token) => token.start === index)
          }
          t={t}
          disabled={imageDisabled}
        />
        {slots?.overlay}
        {example.visible && (
          <div className="composer-example-hint" aria-hidden="true">
            <span className="composer-example-text">
              {example.text}
              <span className="composer-example-caret" />
            </span>
            {example.adoptText && (
              <span className="composer-example-adopt">
                <kbd>{t('composer.example.tab')}</kbd> {t('composer.example.adopt')}
              </span>
            )}
          </div>
        )}
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
            disabled={view.input.disabled || (!!view.readOnly && !view.loading)}
            placeholder={view.readOnly ? t('composer.hint.readOnly') : view.input.placeholder}
            autoSize={nativeSizing ? false : AUTO_SIZE}
            {...(nativeSizing ? { styles: NATIVE_INPUT_STYLES } : {})}
            onChange={changeDraft}
            onKeyDown={(event) => {
              const native = event.nativeEvent as KeyboardEvent
              if (event.key === 'Escape' && example.visible && !native.isComposing) {
                event.preventDefault()
                // Closing the ghost is a decision; the emptied draft must not bring it back.
                example.dismiss()
                return false
              }
              if (
                event.key === 'Tab' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                !native.isComposing &&
                example.adoptText &&
                !currentDraft() &&
                !attachmentsRef.current.length &&
                !pendingCountRef.current &&
                !uploads.count()
              ) {
                event.preventDefault()
                editDraft(0, 0, example.adoptText)
                return false
              }
              // A file chip is one piece of text: Backspace and Delete take it whole.
              mentions.keydown({
                key: event.key,
                isComposing: native.isComposing,
                preventDefault: () => event.preventDefault(),
              })
              if (event.defaultPrevented) return false
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
                submitAsSteer.current = event.metaKey || event.ctrlKey
                if (currentDraft().trim() || hasAttachments) form.current?.requestSubmit()
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
                  imagesAllowed={policy.supported}
                  onRemove={removeImage}
                  t={t}
                />
                {slots?.attachments}
              </div>
            }
            footer={
              <div className="composer-controls">
                {!view.readOnly && addButton}
                {slots?.permission}
                {!view.readOnly && (
                  <dependencies.PermissionPicker
                    state={view.permission}
                    onError={onError}
                    onSelect={onPermissionSelect}
                  />
                )}
                <p id="composer-hint" data-kind={view.hint.kind} hidden={view.readOnly}>
                  {view.hint.text}
                </p>
                {view.hint.action && (
                  <Button
                    className="composer-hint-action"
                    data-testid="composer-use-model"
                    disabled={view.model.pending}
                    onClick={() => {
                      const model = view.hint.action?.model
                      if (model) void Promise.resolve(onModelSelect(model)).catch(onError)
                    }}
                  >
                    {view.hint.action.label}
                  </Button>
                )}
                {slots?.model}
                {/* Context use sits with the model it measures: a ring and a share, details on hover. */}
                <section id="session-usage" aria-label={t('composer.usage.label')} hidden={!showUsage}>
                  <dependencies.UsagePanel usage={view.usage} connected={view.connected} t={t} />
                </section>
                {!view.readOnly && (
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
                )}
                {view.controls ? (
                  // Pause and stop are a pair of same-size icon buttons; paused, this one turns into continue.
                  <Tooltip
                    title={
                      view.controls.pauseSupported
                        ? t(view.controls.paused ? 'composer.control.resume' : 'composer.control.pauseTitle')
                        : view.controls.reason
                    }
                  >
                    <Button
                      htmlType="button"
                      appearance="ghost"
                      id="composer-pause"
                      data-testid="composer-pause-resume"
                      hidden={view.cancel.hidden}
                      disabled={
                        view.controls.disabled || view.controls.pending || !view.controls.pauseSupported
                      }
                      aria-label={t(
                        view.controls.paused ? 'composer.control.resume' : 'composer.control.pause',
                      )}
                      aria-pressed={view.controls.paused}
                      icon={<Icon name={view.controls.paused ? 'play' : 'pause'} size={16} />}
                      onClick={onPauseResume}
                    />
                  </Tooltip>
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
                  hidden={view.readOnly}
                  appearance="primary"
                  htmlType="submit"
                  disabled={view.send.disabled}
                  data-mode={view.send.mode}
                  aria-label={view.send.label}
                  // The keyboard contract lives in the button's tooltip, not as chips inside the card.
                  title={view.hint.kind === 'shortcut' ? view.hint.text : view.send.title}
                >
                  <span className="visually-hidden">{view.send.label}</span>
                  <Icon name="arrow-up" size={18} />
                </Button>
              </div>
            }
          />
        </XProvider>
        <FileMentionLayer
          prompt={prompt}
          draft={draft}
          tokens={mentionTokensInDraft}
          remove={mentions.remove}
          t={t}
        />
        <SettingsInput
          ref={fileInput}
          type="file"
          disabled={imageDisabled}
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
        <span id="composer-suggestion" className="visually-hidden">
          {example.adoptText
            ? `${example.adoptText} — ${t('composer.example.tab')} ${t('composer.example.adopt')}`
            : ''}
        </span>
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
          {dependencies.WorkspacePicker && onWorkspaceSelect ? (
            <dependencies.WorkspacePicker
              workspace={view.workspace}
              hidden={!(view.workspace.visible ?? !view.hasSession)}
              onWorkspace={onWorkspace}
              onSelect={onWorkspaceSelect}
              {...(onWorkspaceRemove ? { onRemove: onWorkspaceRemove } : {})}
            />
          ) : (
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
              {view.workspace.path && <span data-workspace-path={true}>{view.workspace.path}</span>}
              <Icon name="chevron-down" className="model-chevron" />
            </Button>
          )}
        </div>
        <div className="composer-meta-end">{slots?.dock}</div>
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
  WorkspacePickerProps,
} from './composer/contracts.js'
export { downscaleImageFile } from './composer/image-files.js'

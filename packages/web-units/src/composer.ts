import type { ContentBlock, ModelSettings, UsageView } from '@agnes/protocol'
import {
  decodeSafeImageBytes,
  decodeSafeImages,
  USER_MESSAGE_IMAGE_LIMITS,
  USER_MESSAGE_IMAGE_MAX_COUNT,
} from '@agnes/protocol-validation'
import { ModelSettingsDialog } from '@agnes/web-ui'
import {
  type ClipboardEvent,
  type ComponentType,
  createElement,
  type DragEvent,
  type FormEvent,
  type ForwardedRef,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'

export type ModelPickerOption = { id: string; route: string; label?: string }
export type ModelPickerState = {
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
}
export type ModelPicker = {
  destroy(): void
  render(state: ModelPickerState): void
}
export type PermissionMode = 'view' | 'workspace' | 'full'
export type ComposerImageBlock = Extract<ContentBlock, { type: 'image' }>
export type PermissionPickerState = { disabled: boolean; pending: boolean; selected: PermissionMode | null }
export type PermissionPicker = {
  destroy(): void
  render(state: PermissionPickerState): void
}

/** DOM helpers remain host adapters so this package has no dependency on the Web application. */
export interface ComposerDependencies {
  createModelPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(option: ModelPickerOption): Promise<boolean>
  }): ModelPicker
  createPermissionPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(mode: PermissionMode): Promise<boolean>
  }): PermissionPicker
  createUsagePanel(parent: HTMLElement): ((usage: UsageView | undefined, connected: boolean) => void) & {
    dispose?(): void
  }
  /** Component injection keeps production usage in the composer root; factories remain compatible. */
  UsagePanel?: ComponentType<{ usage: UsageView | undefined; connected: boolean }>
  isSubmitShortcut(event: {
    key: string
    shiftKey: boolean
    isComposing: boolean
    keyCode: number
    metaKey: boolean
    ctrlKey: boolean
  }): boolean
  resize(textarea: HTMLTextAreaElement): void
}

export interface ComposerView {
  cancel: { disabled: boolean; hidden: boolean; label: string }
  connected: boolean
  configured: boolean
  hasSession: boolean
  hint: { kind: 'shortcut' | 'state'; text: string }
  input: { disabled: boolean; placeholder: string }
  loading: boolean
  model: ModelPickerState
  modelSettings?: {
    key: string
    settings: ModelSettings
    contextWindow: number
    thinkingLevelMap?: Record<string, string> | undefined
  }
  permission: PermissionPickerState
  sending: boolean
  send: { disabled: boolean; label: string; mode: 'idle' | 'busy' | 'pending'; title: string }
  stopping: boolean
  usage: UsageView | undefined
  workspace: { disabled: boolean; label: string; title: string }
}

export interface ComposerHandle {
  clearImageBlocks(): void
  focus(): void
  getDraft(): string
  getImageBlocks(): readonly ComposerImageBlock[]
  hasPendingImages(): boolean
  render(view: ComposerView): void
  restoreImageBlocks(images: readonly ComposerImageBlock[]): void
  resize(): void
  setDraft(value: string): void
}

export interface ComposerRegionOptions {
  initialDraft?: string
  onCancel(): void
  onAttachmentsChange?(): void
  onDraftChange(value: string): void
  onError(error: unknown): void
  onModelSelect(option: ModelPickerOption): Promise<boolean>
  onModelSettingsChange?(settings: ModelSettings): Promise<boolean>
  onPermissionSelect(mode: PermissionMode): Promise<boolean>
  onSubmit(): void
  onWorkspace(): void
}

export interface ComposerSlots {
  attachments?: ReactNode
  dock?: ReactNode
  left?: ReactNode
  model?: ReactNode
  overlay?: ReactNode
  permission?: ReactNode
  plan?: ReactNode
  right?: ReactNode
}

const INITIAL_VIEW: ComposerView = {
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: false,
  configured: false,
  hasSession: false,
  hint: { kind: 'state', text: '连接后台后开始' },
  input: { disabled: true, placeholder: '描述你想完成的事…' },
  loading: false,
  model: {
    accessibleName: '选择当前会话模型',
    disabled: true,
    label: '选择模型',
    options: [],
    pending: false,
  },
  permission: { disabled: true, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: true, label: '发送', mode: 'idle', title: '发送（Enter）' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: true, label: '选择工作区', title: '选择工作区' },
}

interface ComposerProps extends ComposerRegionOptions {
  initialView?: ComposerView
  dependencies: ComposerDependencies
  slots?: ComposerSlots
}

type ComposerAttachment = ComposerImageBlock & { id: string; previewUrl: string; size: number }

const MAX_IMAGE_COUNT = USER_MESSAGE_IMAGE_MAX_COUNT
const MAX_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage
const MAX_TOTAL_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes
const IMAGE_PREVIEW_LIMITS = USER_MESSAGE_IMAGE_LIMITS

function composerCopy() {
  const english = document.documentElement.lang.toLowerCase().startsWith('en')
  return english
    ? {
        imageAlt: (index: number) => `Attached image ${index + 1}`,
        imageLimit: 'PNG and JPEG, up to 4 images and 1 MiB total.',
        imageReading: 'Reading image…',
        invalidImage: 'The file is not a valid PNG or JPEG image.',
        invalidType: 'Only PNG and JPEG images are supported.',
        readFailed: 'The image could not be read.',
        removeImage: (index: number) => `Remove image ${index + 1}`,
        tooMany: 'A message can contain up to 4 images.',
        tooLarge: 'Images in one message must total no more than 1 MiB.',
      }
    : {
        imageAlt: (index: number) => `附件图片 ${index + 1}`,
        imageLimit: '支持 PNG 和 JPEG，最多 4 张，合计不超过 1 MiB。',
        imageReading: '正在读取图片…',
        invalidImage: '文件内容不是有效的 PNG 或 JPEG 图片。',
        invalidType: '目前只支持 PNG 和 JPEG 图片。',
        readFailed: '无法读取图片文件。',
        removeImage: (index: number) => `移除图片 ${index + 1}`,
        tooMany: '一条消息最多添加 4 张图片。',
        tooLarge: '单条消息中的图片合计不能超过 1 MiB。',
      }
}

async function readImage(file: File): Promise<{ data: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return { data: btoa(binary), bytes }
}

function blobBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    initialDraft = '',
    initialView = INITIAL_VIEW,
    dependencies,
    onCancel,
    onAttachmentsChange,
    onDraftChange,
    onError,
    onModelSelect,
    onModelSettingsChange,
    onPermissionSelect,
    onSubmit,
    onWorkspace,
    slots,
  }: ComposerProps,
  ref: ForwardedRef<ComposerHandle>,
) {
  const [view, setView] = useState<ComposerView>(initialView)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const form = useRef<HTMLFormElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const model = useRef<HTMLButtonElement>(null)
  const permission = useRef<HTMLButtonElement>(null)
  const usage = useRef<HTMLElement>(null)
  const modelPicker = useRef<ModelPicker>()
  const permissionPicker = useRef<PermissionPicker>()
  const renderUsage = useRef<ReturnType<ComposerDependencies['createUsagePanel']>>()
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const generation = useRef(0)
  const nextAttachmentId = useRef(0)
  const pendingCountRef = useRef(0)
  const pendingBytes = useRef(0)

  const publishAttachments = useCallback(
    (next: ComposerAttachment[]): void => {
      attachmentsRef.current = next
      setAttachments(next)
      onAttachmentsChange?.()
    },
    [onAttachmentsChange],
  )

  const clearImageBlocks = useCallback((): void => {
    generation.current += 1
    pendingCountRef.current = 0
    pendingBytes.current = 0
    setPendingCount(0)
    for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl)
    publishAttachments([])
  }, [publishAttachments])

  const restoreImageBlocks = useCallback(
    (images: readonly ComposerImageBlock[]): void => {
      clearImageBlocks()
      if (images.length > MAX_IMAGE_COUNT) return
      let decoded: ReturnType<typeof decodeSafeImages>
      try {
        decoded = decodeSafeImages(images, IMAGE_PREVIEW_LIMITS)
      } catch {
        return
      }

      const restored: ComposerAttachment[] = []
      try {
        for (const [index, image] of images.entries()) {
          const bytes = decoded[index]?.bytes
          if (!bytes) throw new Error('validated image bytes are unavailable')
          const blob = new Blob([blobBytes(bytes)], { type: image.mimeType })
          restored.push({
            ...image,
            id: `restored-${++nextAttachmentId.current}`,
            previewUrl: URL.createObjectURL(blob),
            size: bytes.byteLength,
          })
        }
      } catch {
        for (const attachment of restored) URL.revokeObjectURL(attachment.previewUrl)
        return
      }
      publishAttachments(restored)
    },
    [clearImageBlocks, publishAttachments],
  )

  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (view.sending) return
    const copy = composerCopy()
    const accepted: File[] = []
    let candidateBytes = 0
    for (const file of files) {
      if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
        onError(new Error(copy.invalidType))
        continue
      }
      if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
        onError(new Error(copy.tooLarge))
        continue
      }
      if (attachmentsRef.current.length + pendingCountRef.current + accepted.length >= MAX_IMAGE_COUNT) {
        onError(new Error(copy.tooMany))
        continue
      }
      if (
        attachmentsRef.current.reduce((sum, image) => sum + image.size, 0) +
          pendingBytes.current +
          candidateBytes +
          file.size >
        MAX_TOTAL_IMAGE_BYTES
      ) {
        onError(new Error(copy.tooLarge))
        continue
      }
      accepted.push(file)
      candidateBytes += file.size
    }
    if (accepted.length === 0) return

    const readGeneration = generation.current
    pendingCountRef.current += accepted.length
    pendingBytes.current += candidateBytes
    setPendingCount(pendingCountRef.current)
    onAttachmentsChange?.()

    await Promise.all(
      accepted.map(async (file) => {
        try {
          const { data, bytes } = await readImage(file)
          if (readGeneration !== generation.current) return
          try {
            decodeSafeImageBytes({ bytes, mimeType: file.type }, IMAGE_PREVIEW_LIMITS)
          } catch {
            throw new Error(copy.invalidImage)
          }
          const attachment: ComposerAttachment = {
            type: 'image',
            data,
            mimeType: file.type,
            id: `image-${++nextAttachmentId.current}`,
            previewUrl: URL.createObjectURL(file),
            size: file.size,
          }
          publishAttachments([...attachmentsRef.current, attachment])
        } catch (error) {
          if (readGeneration === generation.current)
            onError(
              error instanceof Error && error.message === copy.invalidImage
                ? error
                : new Error(copy.readFailed),
            )
        } finally {
          if (readGeneration === generation.current) {
            pendingCountRef.current -= 1
            pendingBytes.current -= file.size
            setPendingCount(pendingCountRef.current)
            onAttachmentsChange?.()
          }
        }
      }),
    )
  }

  const removeImage = (id: string): void => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id)
    if (!removed) return
    URL.revokeObjectURL(removed.previewUrl)
    publishAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id))
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const clipboard = event.clipboardData
    const itemFiles: File[] = []
    for (const item of Array.from(clipboard.items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) itemFiles.push(file)
    }
    const files = itemFiles.length > 0 ? itemFiles : Array.from(clipboard.files)
    if (files.length === 0) return
    event.preventDefault()
    const text = clipboard.getData('text/plain')
    if (text) {
      const textarea = event.currentTarget
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    void addFiles(files)
  }

  const handleDrop = (event: DragEvent<HTMLFormElement>): void => {
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    void addFiles(Array.from(event.dataTransfer.files))
  }

  useLayoutEffect(
    () => () => {
      generation.current += 1
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl)
      attachmentsRef.current = []
    },
    [],
  )

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
        return attachmentsRef.current.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      },
      hasPendingImages() {
        return pendingCountRef.current > 0
      },
      render(next) {
        flushSync(() => setView(next))
      },
      restoreImageBlocks,
      resize() {
        if (prompt.current) dependencies.resize(prompt.current)
      },
      setDraft(value) {
        if (!prompt.current || prompt.current.value === value) return
        prompt.current.value = value
        dependencies.resize(prompt.current)
      },
    }),
    [dependencies.resize, clearImageBlocks, restoreImageBlocks],
  )

  useLayoutEffect(() => {
    if (!model.current || !permission.current || !usage.current) return
    modelPicker.current = dependencies.createModelPicker({
      trigger: model.current,
      onError,
      onSelect: onModelSelect,
    })
    permissionPicker.current = dependencies.createPermissionPicker({
      trigger: permission.current,
      onError,
      onSelect: onPermissionSelect,
    })
    if (!dependencies.UsagePanel) renderUsage.current = dependencies.createUsagePanel(usage.current)
    return () => {
      modelPicker.current?.destroy()
      permissionPicker.current?.destroy()
      modelPicker.current = undefined
      permissionPicker.current = undefined
      renderUsage.current?.dispose?.()
      renderUsage.current = undefined
    }
  }, [dependencies, onError, onModelSelect, onPermissionSelect])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the preceding effect replaces handles when these inputs change.
  useLayoutEffect(() => {
    modelPicker.current?.render(view.model)
    permissionPicker.current?.render(view.permission)
    renderUsage.current?.(view.usage, view.connected)
  }, [view, dependencies, onError, onModelSelect, onPermissionSelect])

  return createElement(
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
    slots?.overlay,
    createElement(
      'div',
      { className: 'composer-writing' },
      createElement('label', { className: 'visually-hidden', htmlFor: 'prompt' }, '任务内容'),
      createElement('textarea', {
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
      createElement(
        'div',
        { className: 'composer-image-attachments' },
        createElement(
          'div',
          {
            className: 'composer-image-preview-list',
            'aria-label': composerCopy().imageLimit,
            'aria-live': 'polite',
          },
          ...attachments.map((attachment, index) =>
            createElement(
              'figure',
              { className: 'composer-image-preview', key: attachment.id },
              createElement('img', { src: attachment.previewUrl, alt: composerCopy().imageAlt(index) }),
              createElement(
                'button',
                {
                  type: 'button',
                  'data-remove-image': true,
                  'aria-label': composerCopy().removeImage(index + 1),
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
                composerCopy().imageReading,
              )
            : undefined,
        ),
      ),
      slots?.attachments,
    ),
    createElement(
      'div',
      { className: 'composer-controls' },
      slots?.left,
      createElement(
        'button',
        {
          id: 'composer-workspace',
          className: 'composer-workspace',
          type: 'button',
          'aria-haspopup': 'dialog',
          title: view.workspace.title,
          disabled: view.workspace.disabled,
          onClick: onWorkspace,
        },
        createElement(
          'svg',
          {
            className: 'icon icon-folder',
            'data-agnes-region': 'icon',
            viewBox: '0 0 16 16',
            'aria-hidden': true,
          },
          createElement('path', {
            d: 'M5.37012 2.8418C5.52719 2.84178 5.68146 2.88387 5.81641 2.96289C5.95148 3.04201 6.06232 3.15581 6.13672 3.29199L6.74414 4.40137H12.7383C13.2166 4.40139 13.6084 4.78249 13.6084 5.25391V12.6631C13.6082 13.1343 13.2165 13.5146 12.7383 13.5146H2.7627C2.28458 13.5146 1.89277 13.1343 1.89258 12.6631V3.69434C1.89258 3.22297 2.28447 2.84189 2.7627 2.8418H5.37012ZM2.83496 11.4932V12.5908H12.667V11.5645H12.666V8.00488L2.84961 7.99121L2.83496 11.4932ZM2.83496 7.06738H12.666V5.32617H6.18066L6.16016 5.28809L5.32715 3.76562H2.83496V7.06738Z',
          }),
        ),
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
        'button',
        {
          ref: permission,
          id: 'composer-permission',
          className: 'composer-permission',
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': false,
          'aria-label': '选择本会话权限',
          title: '工作区内修改',
          disabled: view.permission.disabled,
        },
        createElement(
          'svg',
          { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
          createElement('path', {
            d: 'M12 3 5 6.5v5.2c0 4.4 2.9 8.4 7 9.8 4.1-1.4 7-5.4 7-9.8V6.5L12 3zm0 2.1 5 2.5v4.1c0 3.4-2.2 6.5-5 7.7-2.8-1.2-5-4.3-5-7.7V7.6l5-2.5z',
          }),
        ),
        createElement('span', { 'data-permission-label': true }, '工作区内修改'),
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
      slots?.right,
      slots?.plan,
      createElement(
        'div',
        { className: 'model-field' },
        createElement(
          'button',
          {
            ref: model,
            id: 'model',
            type: 'button',
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
      view.modelSettings && onModelSettingsChange
        ? createElement(ModelSettingsDialog, {
            ...view.modelSettings,
            disabled: view.model.disabled || view.model.pending,
            onApply: onModelSettingsChange,
          })
        : undefined,
      createElement(
        'section',
        {
          ref: usage,
          id: 'session-usage',
          'aria-label': '上下文用量',
          hidden: dependencies.UsagePanel ? !view.usage : true,
        },
        dependencies.UsagePanel
          ? createElement(dependencies.UsagePanel, {
              usage: view.usage,
              connected: view.connected,
            })
          : undefined,
      ),
      createElement(
        'button',
        {
          id: 'cancel',
          className: 'secondary-button compact',
          type: 'button',
          hidden: view.cancel.hidden,
          disabled: view.cancel.disabled,
          onClick: onCancel,
        },
        view.cancel.label,
      ),
      createElement(
        'button',
        {
          id: 'send',
          className: 'primary-button',
          type: 'submit',
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
  )
})

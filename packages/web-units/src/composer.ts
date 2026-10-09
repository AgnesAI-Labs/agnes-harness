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

import type { SessionControlledChild } from '@agnes/protocol/gen/agnes-v1'
import type { ContentBlock, ModelSettings, ThinkingLevel, UIPendingInput, UsageView } from '@agnes/protocol'
import { uploadedAttachment, userImagePolicy } from '@agnes/protocol'
import {
  decodeAttachmentData,
  decodeSafeImageBytes,
  decodeSafeImages,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentType,
  createElement,
  type DragEvent,
  type FormEvent,
  type ForwardedRef,
  Fragment,
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
import { ReferencePicker, type ComposerReferences } from './reference-picker.js'
import { useComposerUploads } from './composer-uploads.js'
import { composerLocaleCatalog } from './locales/composer.js'
import type { Translate } from './locales/index.js'

export type ModelPickerOption = {
  id: string
  route: string
  label?: string
  /** 模型声明的「档位 → provider 取值」映射；缺省表示任意合法档位都接受。 */
  thinkingLevelMap?: Record<string, string>
}
/** 面板里「思考强度」与「上下文预算」两段的会话现状；字段与宿主侧 ModelPickerSettings 对齐。 */
export type ModelPickerSettings = {
  thinking?: ThinkingLevel
  contextWindow?: number
  /** 模型目录容量，同时是预算校验的上界。 */
  capacity: number
  thinkingLevelMap?: Record<string, string>
}
export type ModelPickerState = {
  accessibleName: string
  disabled: boolean
  label: string
  options: readonly ModelPickerOption[]
  pending: boolean
  selected?: ModelPickerOption
  settings?: ModelPickerSettings
}
export type ModelPicker = {
  destroy(): void
  render(state: ModelPickerState): void
}
export type PermissionMode = 'view' | 'workspace' | 'full'
export type ComposerImageBlock = Extract<ContentBlock, { type: 'image' }>
export type ComposerAttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' | 'resource_link' }>
export type PermissionPickerState = { disabled: boolean; pending: boolean; selected: PermissionMode | null }
export type PermissionPicker = {
  destroy(): void
  render(state: PermissionPickerState): void
}

/** DOM helpers remain host adapters so this package has no dependency on the Web application. */
export interface ComposerDependencies {
  /** Locale-bound translate (host injects `LocaleService#t`); called during render, never cached. */
  translate: Translate
  createModelPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(option: ModelPickerOption): Promise<boolean>
    /** 面板内改档位或预算时的提交口；缺省时面板只渲染模型列表。 */
    onSettingsChange?(settings: ModelSettings): Promise<boolean>
  }): ModelPicker
  createPermissionPicker(options: {
    trigger: HTMLButtonElement
    onError(error: unknown): void
    onSelect(mode: PermissionMode): Promise<boolean>
  }): PermissionPicker
  createUsagePanel(
    parent: HTMLElement,
    t?: Translate,
  ): ((usage: UsageView | undefined, connected: boolean) => void) & {
    dispose?(): void
  }
  /** 上传前把超出模型视觉上限的图片缩小；缺省时按原图发送。 */
  downscaleImage?(file: File, policy?: ReturnType<typeof userImagePolicy>): Promise<File>
  /** Component injection keeps production usage in the composer root; factories remain compatible. */
  UsagePanel?: ComponentType<{ usage: UsageView | undefined; connected: boolean; t?: Translate }>
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
  children?: readonly SessionControlledChild[]
  childrenDisabled?: boolean

  imagePolicy?: ReturnType<typeof userImagePolicy>
  cancel: { disabled: boolean; hidden: boolean; label: string }
  controls?: {
    paused: boolean
    pending: boolean
    disabled: boolean
    pauseSupported: boolean
    interruptSupported: boolean
    reason: string
  }
  connected: boolean
  configured: boolean
  hasSession: boolean
  hint: { kind: 'shortcut' | 'state'; text: string }
  input: { disabled: boolean; placeholder: string }
  loading: boolean
  model: ModelPickerState
  modelSettings?: {
    settings: ModelSettings
    /** 模型目录容量，不是本会话已保存的预算。 */
    contextWindow: number
    thinkingLevelMap?: Record<string, string> | undefined
  }
  permission: PermissionPickerState
  queue?: {
    items: readonly (UIPendingInput & { editText?: string })[]
    disabled: boolean
    removeDisabled?: boolean
    sending?: string
    removing?: string
    interruptSupported?: boolean
    reason?: string
    error?: string
  }
  sending: boolean
  send: { disabled: boolean; label: string; mode: 'idle' | 'busy' | 'pending'; title: string }
  stopping: boolean
  usage: UsageView | undefined
  workspace: { disabled: boolean; label: string; title: string }
}

export interface ComposerHandle {
  getAttachmentBlocks(): readonly ComposerAttachmentBlock[]
  restoreAttachmentBlocks(attachments: readonly ComposerAttachmentBlock[]): void
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
  references?: ComposerReferences
  initialDraft?: string
  onCancel(): void
  onAttachmentsChange?(): void
  prepareUploadSession?(): Promise<string>
  onDraftChange(value: string): void
  onError(error: unknown): void
  onModelSelect(option: ModelPickerOption): Promise<boolean>
  onModelSettingsChange?(settings: ModelSettings): Promise<boolean>
  onPermissionSelect(mode: PermissionMode): Promise<boolean>
  onSubmit(): void
  onChildControl?(id: string, action: 'stop' | 'continue', text?: string): Promise<void>
  onPauseResume?(): void
  onEditQueued?(itemId: string, text: string): Promise<void>
  onSendNow?(itemId: string): void
  onRemoveQueued?(itemId: string): void
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

/** 会话设置只在已知模型上有值；缺失时面板退化成纯模型列表。 */
function pickerState(view: ComposerView): ModelPickerState {
  const settings = view.modelSettings
  if (!settings) return view.model
  return {
    ...view.model,
    settings: {
      ...(settings.settings.thinking ? { thinking: settings.settings.thinking } : {}),
      ...(settings.settings.contextWindow === undefined
        ? {}
        : { contextWindow: settings.settings.contextWindow }),
      capacity: settings.contextWindow,
      ...(settings.thinkingLevelMap ? { thinkingLevelMap: settings.thinkingLevelMap } : {}),
    },
  }
}

const INITIAL_VIEW: ComposerView = {
  cancel: { disabled: true, hidden: true, label: composerLocaleCatalog.en['composer.initial.stop']! },
  connected: false,
  configured: false,
  hasSession: false,
  hint: { kind: 'state', text: composerLocaleCatalog.en['composer.initial.connect']! },
  input: { disabled: true, placeholder: composerLocaleCatalog.en['composer.initial.placeholder']! },
  loading: false,
  model: {
    accessibleName: composerLocaleCatalog.en['composer.initial.modelAria']!,
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.model']!,
    options: [],
    pending: false,
  },
  permission: { disabled: true, pending: false, selected: 'workspace' },
  sending: false,
  send: {
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.send']!,
    mode: 'idle',
    title: composerLocaleCatalog.en['composer.initial.sendTitle']!,
  },
  stopping: false,
  usage: undefined,
  workspace: {
    disabled: true,
    label: composerLocaleCatalog.en['composer.initial.workspace']!,
    title: composerLocaleCatalog.en['composer.initial.workspace']!,
  },
}

interface ComposerProps extends ComposerRegionOptions {
  initialView?: ComposerView
  dependencies: ComposerDependencies
  slots?: ComposerSlots
}

type ComposerAttachment = ComposerAttachmentBlock & {
  id: string
  previewUrl?: string
  size: number
  pixels: number
}

const MAX_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage
const MAX_TOTAL_IMAGE_BYTES = USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes
const IMAGE_PREVIEW_LIMITS = USER_MESSAGE_IMAGE_LIMITS
/**
 * 源文件的粗上限，只为避免把超大文件整体读进内存再交给 canvas。真正的每张与合计上限看
 * 缩放之后的结果：一张几 MB 的截图缩完往往只剩几百 KB，按原图卡会在能缩小之前就拒掉。
 */
const MAX_SOURCE_IMAGE_BYTES = USER_MESSAGE_ATTACHMENT_LIMITS.maxAggregateBytes

/** Product preprocessing limit; a model may declare stricter dimensions. */
const IMAGE_MAX_EDGE = 1456

/**
 * 把长边超过 IMAGE_MAX_EDGE 的图片缩到该边长，格式和文件名保持不变。只对超限的图动手；
 * 浏览器可读但严格校验不接受的 JPEG 也会重新编码；正常小图保持原样。
 * canvas 不可用或编码失败时原样返回，交给服务端按原图判定。
 */
export async function downscaleImageFile(file: File, policy = userImagePolicy(undefined)): Promise<File> {
  // 有些 DOM 实现没有位图解码（测试环境就是），那种情况下按原图走，交给服务端判定。
  if (typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // 文件本身解不开时也按原图走：拒绝与否由服务端的格式校验决定，这里不下结论。
    return file
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const ratio = Math.min(
      1,
      IMAGE_MAX_EDGE / longest,
      policy.maxWidth / bitmap.width,
      policy.maxHeight / bitmap.height,
    )
    const encodedSize = 4 * Math.ceil(file.size / 3)
    if (ratio === 1 && encodedSize <= (policy.maxBase64Bytes ?? Infinity)) {
      if (file.type !== 'image/jpeg') return file
      try {
        decodeSafeImageBytes(
          { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type },
          IMAGE_PREVIEW_LIMITS,
        )
        return file
      } catch {
        // 浏览器已成功解码；通过 canvas 去掉尾部附加数据等不兼容结构。
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // PNG 会忽略质量参数，JPEG 用它。保持原格式，避免截图上的小字被有损编码糊掉。
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, file.type, (policy.jpegQuality ?? 92) / 100),
    )
    if (!blob) return file
    return new File([blob], file.name, { type: file.type })
  } finally {
    bitmap.close()
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

const nativeImageFile = (file: File): boolean =>
  file.type === 'image/png' ||
  file.type === 'image/jpeg' ||
  (!file.type && /\.(png|jpe?g)$/iu.test(file.name))

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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const policy = view.imagePolicy ?? userImagePolicy(undefined)
  const currentView = useRef(view)
  currentView.current = view
  const imageDisabled = view.input.disabled || view.sending || view.model.pending
  const imageHint = dependencies.translate('composer.attachment.hint')
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
  const pendingImageCountRef = useRef(0)

  const publishAttachments = useCallback(
    (next: ComposerAttachment[]): void => {
      attachmentsRef.current = next
      setAttachments(next)
      onAttachmentsChange?.()
    },
    [onAttachmentsChange],
  )

  const uploads = useComposerUploads(
    prepareUploadSession,
    (attachment, id, size) => {
      publishAttachments([...attachmentsRef.current, { ...attachment, id, size, pixels: 0 }])
    },
    onAttachmentsChange,
    dependencies.translate,
  )

  const clearImageBlocks = useCallback((): void => {
    generation.current += 1
    uploads.clear()
    pendingCountRef.current = 0
    pendingImageCountRef.current = 0
    setPendingCount(0)
    for (const attachment of attachmentsRef.current)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    publishAttachments([])
  }, [publishAttachments])

  const restoreAttachmentBlocks = useCallback(
    (blocks: readonly ComposerAttachmentBlock[]): void => {
      let decoded: ReturnType<typeof decodeSafeImages>
      try {
        validateUserAttachments(blocks)
        decoded = decodeSafeImages(
          blocks.filter((block): block is ComposerImageBlock => block.type === 'image'),
          IMAGE_PREVIEW_LIMITS,
        )
      } catch {
        return
      }

      const restored: ComposerAttachment[] = []
      try {
        let imageIndex = 0
        for (const image of blocks) {
          if (image.type === 'resource_link') {
            const ref = uploadedAttachment(image.uri)
            if (!ref) throw new Error('Invalid uploaded attachment')
            restored.push({
              ...image,
              id: `restored-${++nextAttachmentId.current}`,
              size: ref.size,
              pixels: 0,
            })
            continue
          }
          if (image.type === 'file') {
            restored.push({
              ...image,
              id: `restored-${++nextAttachmentId.current}`,
              size: decodeAttachmentData(image.data, MAX_TOTAL_IMAGE_BYTES).byteLength,
              pixels: 0,
            })
            continue
          }
          const imageData = decoded[imageIndex++]
          if (!imageData) throw new Error('validated image bytes are unavailable')
          const bytes = imageData.bytes
          const blob = new Blob([blobBytes(bytes)], { type: image.mimeType })
          restored.push({
            ...image,
            id: `restored-${++nextAttachmentId.current}`,
            previewUrl: URL.createObjectURL(blob),
            size: bytes.byteLength,
            pixels: imageData.pixels,
          })
        }
      } catch {
        for (const attachment of restored)
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
        return
      }
      clearImageBlocks()
      publishAttachments(restored)
    },
    [clearImageBlocks, publishAttachments],
  )

  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (imageDisabled) {
      onError(new Error(imageHint))
      return
    }
    // Prepare the draft's session before reading a mixed file/image batch: opening it clears the
    // composer generation. Restore existing inline cards with fresh preview URLs after that clear.
    if (
      prepareUploadSession &&
      !view.hasSession &&
      files.some((file) => !(policy.supported && nativeImageFile(file)))
    ) {
      const saved = attachmentsRef.current.map(
        ({ id: _id, size: _size, pixels: _pixels, previewUrl: _preview, ...block }) => block,
      )
      try {
        await prepareUploadSession()
        if (saved.length) restoreAttachmentBlocks(saved)
      } catch (error) {
        onError(error)
        return
      }
    }
    const t = dependencies.translate
    // 这张表用于把「内容不是图片」与「读不出来」区分开，所以文案只算一次再比对。
    const invalidImage = t('composer.image.invalid')
    const tooLargeMessage = t('composer.image.tooLarge')
    const accepted: File[] = []
    let acceptedImages = 0
    for (const file of files) {
      const visual = policy.supported && nativeImageFile(file)
      // 源图只做粗筛：体积上限留到缩放之后再判，否则大截图会在能被缩小之前就被拒掉。
      if (
        (!uploads.available || visual) &&
        file.size > (visual ? MAX_SOURCE_IMAGE_BYTES : MAX_TOTAL_IMAGE_BYTES)
      ) {
        onError(new Error(tooLargeMessage))
        continue
      }
      if (
        attachmentsRef.current.length + pendingCountRef.current + uploads.count() + accepted.length >=
        USER_MESSAGE_ATTACHMENT_LIMITS.maxCount
      ) {
        onError(
          new Error(t('composer.attachment.tooMany', { count: USER_MESSAGE_ATTACHMENT_LIMITS.maxCount })),
        )
        continue
      }
      if (
        visual &&
        attachmentsRef.current.filter((block) => block.type === 'image').length +
          pendingImageCountRef.current +
          acceptedImages >=
          policy.maxCount
      ) {
        onError(new Error(t('composer.image.tooMany', { count: policy.maxCount })))
        continue
      }
      accepted.push(file)
      if (visual) acceptedImages++
    }
    if (accepted.length === 0) return

    const streamed = uploads.available
      ? accepted.filter((file) => !(policy.supported && nativeImageFile(file)))
      : []
    uploads.add(streamed)
    for (const file of streamed) accepted.splice(accepted.indexOf(file), 1)
    if (accepted.length === 0) return

    const readGeneration = generation.current
    pendingCountRef.current += accepted.length
    pendingImageCountRef.current += acceptedImages
    setPendingCount(pendingCountRef.current)
    onAttachmentsChange?.()

    for (const file of accepted) {
      if (readGeneration !== generation.current) break
      const visual = policy.supported && nativeImageFile(file)
      await (async () => {
        try {
          const candidate =
            !file.type && /\.(png|jpe?g)$/iu.test(file.name)
              ? new File([file], file.name, { type: /\.png$/iu.test(file.name) ? 'image/png' : 'image/jpeg' })
              : file
          const scaled =
            visual && dependencies.downscaleImage
              ? await dependencies.downscaleImage(candidate, policy)
              : candidate
          if (readGeneration !== generation.current) return
          // Refuse an oversized result before allocating its bytes and base64 copy. Sources may
          // still be large: the gate applies only after the downscaler has had a chance to run.
          if (scaled.size > MAX_IMAGE_BYTES) {
            onError(new Error(tooLargeMessage))
            return
          }
          const { data, bytes } = await readImage(scaled)
          if (readGeneration !== generation.current) return
          if (
            visual &&
            (JSON.stringify(currentView.current.imagePolicy) !== JSON.stringify(view.imagePolicy) ||
              !currentView.current.imagePolicy?.supported)
          ) {
            onError(new Error(t('composer.image.modelChanged')))
            return
          }
          // 每张与合计都按缩放后的体积结算，且必须排在解码之前：解码自己也卡同一批上限，
          // 先解码的话「太大」会被当成「不是有效图片」报出去。
          const current = attachmentsRef.current
          const total = current.reduce((sum, image) => sum + image.size, 0)
          if (scaled.size > MAX_IMAGE_BYTES || total + scaled.size > MAX_TOTAL_IMAGE_BYTES) {
            onError(new Error(tooLargeMessage))
            return
          }
          if (!visual || (scaled.type !== 'image/png' && scaled.type !== 'image/jpeg')) {
            const block = {
              type: 'file' as const,
              data,
              mimeType: scaled.type.split(';')[0]?.trim() || 'application/octet-stream',
              name: file.name,
            }
            validateUserAttachments([block])
            publishAttachments([
              ...current,
              { ...block, id: `file-${++nextAttachmentId.current}`, size: bytes.byteLength, pixels: 0 },
            ])
            return
          }
          if (data.length > (policy.maxBase64Bytes ?? Infinity)) {
            onError(new Error(t('composer.image.modelLimit')))
            return
          }
          if (current.filter((block) => block.type === 'image').length >= policy.maxCount) {
            onError(new Error(t('composer.image.tooMany', { count: policy.maxCount })))
            return
          }
          let pixels: number
          try {
            const decoded = decodeSafeImageBytes({ bytes, mimeType: scaled.type }, IMAGE_PREVIEW_LIMITS)
            pixels = decoded.pixels
            if (
              current.reduce((sum, image) => sum + image.pixels, pixels) >
              IMAGE_PREVIEW_LIMITS.maxAggregatePixels
            ) {
              onError(new Error(t('composer.image.tooManyPixels')))
              return
            }
            if (decoded.width > policy.maxWidth || decoded.height > policy.maxHeight) {
              onError(new Error(t('composer.image.modelLimit')))
              return
            }
          } catch {
            throw new Error(invalidImage)
          }
          const attachment: ComposerAttachment = {
            type: 'image',
            data,
            mimeType: scaled.type,
            id: `image-${++nextAttachmentId.current}`,
            previewUrl: URL.createObjectURL(scaled),
            size: scaled.size,
            pixels,
          }
          // 这里到 publishAttachments 之间没有 await：并发读出的多张图会依次看到彼此已提交的
          // 体积，不会各自按同一份旧快照判定而一起越过合计上限。
          publishAttachments([...current, attachment])
        } catch (error) {
          if (readGeneration === generation.current)
            onError(
              error instanceof Error && error.message === invalidImage
                ? error
                : new Error(t('composer.image.readFailed')),
            )
        } finally {
          if (readGeneration === generation.current) {
            pendingCountRef.current -= 1
            if (visual) pendingImageCountRef.current -= 1
            setPendingCount(pendingCountRef.current)
            onAttachmentsChange?.()
          }
        }
      })()
    }
  }

  const removeImage = (id: string): void => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id)
    if (!removed) return
    if (removed.type === 'resource_link') uploads.remove(id, removed.uri, removed.name, removed.size)
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl)
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
      for (const attachment of attachmentsRef.current)
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
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
    [dependencies.resize, clearImageBlocks, restoreAttachmentBlocks],
  )

  useLayoutEffect(() => {
    if (!model.current || !permission.current || !usage.current) return
    modelPicker.current = dependencies.createModelPicker({
      trigger: model.current,
      onError,
      onSelect: onModelSelect,
      ...(onModelSettingsChange ? { onSettingsChange: onModelSettingsChange } : {}),
    })
    permissionPicker.current = dependencies.createPermissionPicker({
      trigger: permission.current,
      onError,
      onSelect: onPermissionSelect,
    })
    if (!dependencies.UsagePanel)
      renderUsage.current = dependencies.createUsagePanel(usage.current, dependencies.translate)
    return () => {
      modelPicker.current?.destroy()
      permissionPicker.current?.destroy()
      modelPicker.current = undefined
      permissionPicker.current = undefined
      renderUsage.current?.dispose?.()
      renderUsage.current = undefined
    }
  }, [dependencies, onError, onModelSelect, onModelSettingsChange, onPermissionSelect])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the preceding effect replaces handles when these inputs change.
  useLayoutEffect(() => {
    modelPicker.current?.render(pickerState(view))
    permissionPicker.current?.render(view.permission)
    renderUsage.current?.(view.usage, view.connected)
  }, [view, dependencies, onError, onModelSelect, onPermissionSelect])

  // 队列排在输入卡之外、它的上方。排队的消息和正在写的草稿是两件事，同处一张卡里会被读成
  // 一件事。卡片样式（含必须挂在区域钩子上的 backdrop-filter）仍留在
  // [data-agnes-region="composer"]，队列只是它的前一个兄弟节点。
  const queueSection =
    view.queue && (view.queue.items.length > 0 || view.queue.error)
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
                      disabled:
                        view.queue?.disabled || !onSendNow || view.queue?.interruptSupported === false,
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
                        disabled: view.queue?.removeDisabled ?? view.queue?.disabled,
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
  return createElement(
    Fragment,
    null,
    view.children?.length && onChildControl
      ? createElement(ChildControlTree, {
          children: view.children,
          disabled: view.childrenDisabled,
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
        adapter: references,
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
                'button',
                {
                  type: 'button',
                  'data-remove-image': true,
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
            'aria-label': dependencies.translate('composer.permission.accessible'),
            title: dependencies.translate('composer.permission.workspace'),
            disabled: view.permission.disabled,
          },
          createElement(
            'svg',
            { className: 'icon', 'data-agnes-region': 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
            createElement('path', {
              d: 'M12 3 5 6.5v5.2c0 4.4 2.9 8.4 7 9.8 4.1-1.4 7-5.4 7-9.8V6.5L12 3zm0 2.1 5 2.5v4.1c0 3.4-2.2 6.5-5 7.7-2.8-1.2-5-4.3-5-7.7V7.6l5-2.5z',
            }),
          ),
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
        createElement(
          'section',
          {
            ref: usage,
            id: 'session-usage',
            'aria-label': dependencies.translate('composer.usage.label'),
            hidden: dependencies.UsagePanel ? !view.usage : true,
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
              'button',
              {
                type: 'button',
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
          'button',
          {
            'data-testid': 'composer-cancel',
            id: 'cancel',
            className: 'secondary-button compact',
            type: 'button',
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
          'button',
          {
            id: 'composer-attach',
            type: 'button',
            className: 'secondary-button compact',
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
          createElement(
            'svg',
            { className: 'icon', viewBox: '0 0 24 24', 'aria-hidden': true },
            createElement('path', {
              d: 'm16 6l-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551',
            }),
          ),
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
    ),
  )
})

function QueuedInputEditor({
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

function ChildControlTree({
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
function ChildControlRow({
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

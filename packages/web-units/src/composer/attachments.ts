import { storedAttachment, uploadedAttachment, userImagePolicy } from '@agnes/protocol'
import {
  decodeAttachmentData,
  decodeSafeImageBytes,
  decodeSafeImages,
  USER_MESSAGE_ATTACHMENT_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol-validation'
import { type ClipboardEvent, type DragEvent, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { attachmentErrorMessage } from '../composer-errors.js'
import { useComposerUploads } from '../composer-uploads.js'
import type { ComposerAttachmentBlock, ComposerImageBlock, ComposerProps, ComposerView } from './contracts.js'
import {
  blobBytes,
  type ComposerAttachment,
  IMAGE_PREVIEW_LIMITS,
  MAX_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  nativeImageFile,
  readImage,
} from './image-files.js'

type ComposerOptions<K extends keyof ComposerProps> = { [P in K]: ComposerProps[P] }

export function useComposerAttachments({
  view,
  dependencies,
  prepareUploadSession,
  onAttachmentsChange,
  onError,
}: ComposerOptions<'dependencies' | 'prepareUploadSession' | 'onAttachmentsChange' | 'onError'> & {
  view: ComposerView
}) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const policy = view.imagePolicy ?? userImagePolicy(undefined)
  const currentView = useRef(view)
  currentView.current = view
  const imageDisabled = view.input.disabled || view.loading || view.sending || view.model.pending
  const imageHint = dependencies.translate('composer.attachment.hint')

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
    (attachment, id, size, previewUrl) => {
      publishAttachments([
        ...attachmentsRef.current,
        { ...attachment, id, size, pixels: 0, ...(previewUrl ? { previewUrl } : {}) },
      ])
    },
    onAttachmentsChange,
    dependencies.translate,
  )

  const clearImageBlocks = useCallback((): void => {
    generation.current += 1
    uploads.clear()
    const cleared = attachmentsRef.current.length > 0 || pendingCountRef.current > 0
    pendingCountRef.current = 0
    pendingImageCountRef.current = 0
    // A session switch clears an empty composer too; publishing nothing would still re-render the host.
    if (!cleared) return
    setPendingCount(0)
    for (const attachment of attachmentsRef.current)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
    publishAttachments([])
  }, [publishAttachments, uploads])

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
            const ref = storedAttachment(image) ? image.attachment.artifact : uploadedAttachment(image.uri)
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
      onError(new Error(dependencies.translate('composer.attachment.unavailable')))
      return
    }
    // Prepare the draft's session before reading a mixed file/image batch: opening it clears the
    // composer generation. The host carries the typed text into the new session; this restores the
    // existing inline cards with fresh preview URLs after the clear.
    if (prepareUploadSession && !view.hasSession && files.length > 0) {
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
        attachmentsRef.current.filter(
          (block) => block.type === 'image' || (storedAttachment(block) && block.attachment.image),
        ).length +
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

    const streamed = uploads.available ? [...accepted] : []
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
          {
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
            onError(new Error(attachmentErrorMessage(error, t) ?? t('composer.image.readFailed')))
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
    if (removed.type === 'resource_link') uploads.remove(id)
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl)
    publishAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id))
  }

  /** Files become attachments; text pasted alongside them goes through the owner of the draft. */
  const handlePaste = (event: ClipboardEvent<HTMLElement>, insertText: (text: string) => void): void => {
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
    if (text) insertText(text)
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

  return {
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
  }
}

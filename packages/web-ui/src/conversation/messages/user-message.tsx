import type { ContentBlock, UINode } from '@agnes/protocol'
import { storedAttachment, uploadedAttachment } from '@agnes/protocol'
import { decodeSafeImage, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { Image } from 'antd'
import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { Button } from '../../ui/button.js'
import { Disclosure } from '../../ui/disclosure.js'
import { type FileMention, FileMentionChip, fileMentionLinks, fileMentionOf } from '../../ui/file-mention.js'
import { UserMessageReferences } from '../reference-chips.js'
import { systemInputText } from '../user-presentation.js'
import { AttachmentImage, type AttachmentReader } from './attachment-image.js'
import { SubtaskDetailsButton } from './subtask-details.js'

/** 缩略图固定 72×56，和输入框里的待发图片同尺寸：图片不再按原图比例把消息撑长。 */
export const USER_MESSAGE_IMAGE_THUMBNAIL = { width: 72, height: 56 } as const

/** 历史消息里的图片按服务端同一套预算重新判一遍，超出的一张只显示占位说明。 */
export function imageBlobBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function UserMessageImage({
  image,
  index,
  allowed,
  t,
}: {
  image: Extract<ContentBlock, { type: 'image' }>
  index: number
  allowed: boolean
  t: Translate
}) {
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [unavailable, setUnavailable] = useState(false)
  const { data, mimeType } = image
  useEffect(() => {
    if (!allowed) {
      setUnavailable(true)
      return
    }
    let url: string
    try {
      const decoded = decodeSafeImage({ data, mimeType }, USER_MESSAGE_IMAGE_LIMITS)
      url = URL.createObjectURL(new Blob([imageBlobBytes(decoded.bytes)], { type: decoded.mime }))
      setPreviewUrl(url)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
      return
    }
    return () => URL.revokeObjectURL(url)
  }, [allowed, data, mimeType])

  if (unavailable)
    return (
      <span className="user-message-image-unavailable" role="status">
        {t('conversation.imageUnavailable')}
      </span>
    )
  if (!previewUrl) return null
  // antd 的 Image 自带点击放大预览（缩放、旋转、多图左右切换），比自绘弹层省事。
  return (
    <Image
      className="user-message-image"
      src={previewUrl}
      alt={t('conversation.imageAlt', { index: index + 1 })}
      width={USER_MESSAGE_IMAGE_THUMBNAIL.width}
      height={USER_MESSAGE_IMAGE_THUMBNAIL.height}
    />
  )
}

/** 一条用户消息的全部内联图片。 */
export function UserMessageImages({ node, t }: { node: Extract<UINode, { kind: 'user' }>; t: Translate }) {
  const images = node.content.filter((block) => block.type === 'image')
  if (images.length === 0) return null
  let imageBytes = 0
  // 同一条消息里可以粘贴重复的图片：内容摘要相同就靠出现次数区分 key，否则 React 会认成同一张。
  const imageKeys = new Map<string, number>()
  return (
    // 同一条消息的图片归到一个预览组：点开大图后能用左右箭头在几张之间翻。
    <Image.PreviewGroup>
      <div className="user-message-images">
        {images.map((block, index) => {
          const decodedLength =
            Math.floor((block.data.length * 3) / 4) -
            (block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0)
          const allowed =
            decodedLength > 0 &&
            decodedLength <= USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage &&
            imageBytes + decodedLength <= USER_MESSAGE_IMAGE_LIMITS.maxAggregateBytes
          if (allowed) imageBytes += decodedLength
          const imageKey = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 16)}:${block.data.slice(-16)}`
          const occurrence = imageKeys.get(imageKey) ?? 0
          imageKeys.set(imageKey, occurrence + 1)
          return (
            <UserMessageImage
              key={`${imageKey}:${occurrence}`}
              image={block}
              index={index}
              allowed={allowed}
              t={t}
            />
          )
        })}
      </div>
    </Image.PreviewGroup>
  )
}

const NAME_CHAR = /[\p{L}\p{N}_.\-/\\]/u

/**
 * The text with each file it names as a chip. A message names a file as `@name` (or as much of its
 * path as told two files apart) and carries the file's link beside the text.
 */
export function withFileMentions(
  text: string,
  mentions: readonly FileMention[],
): { parts: Array<string | FileMention>; unplaced: FileMention[] } {
  type Hit = { start: number; end: number; mention: FileMention }
  const hits: Hit[] = []
  const placed = new Set<FileMention>()
  const labels = mentions.flatMap((mention) => {
    const segments = mention.path.split(/[\\/]/u).filter(Boolean)
    return segments.map((_, index) => ({ mention, label: segments.slice(index).join('/') }))
  })
  labels.push(...mentions.map((mention) => ({ mention, label: mention.name })))
  labels.sort((a, b) => b.label.length - a.label.length)
  for (const { mention, label } of labels) {
    const token = `@${label}`
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
      const end = at + token.length
      if (NAME_CHAR.test(text[end] ?? '') || hits.some((hit) => at < hit.end && end > hit.start)) continue
      hits.push({ start: at, end, mention })
      placed.add(mention)
    }
  }
  hits.sort((a, b) => a.start - b.start)
  const parts: Array<string | FileMention> = []
  let at = 0
  for (const hit of hits) {
    if (hit.start > at) parts.push(text.slice(at, hit.start))
    parts.push(hit.mention)
    at = hit.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return { parts, unplaced: mentions.filter((mention) => !placed.has(mention)) }
}

function MentionedText({ text, mentions, t }: { text: string; mentions: FileMention[]; t: Translate }) {
  const { parts, unplaced } = withFileMentions(text, mentions)
  const chip = (mention: FileMention, key: string) => (
    <FileMentionChip
      key={key}
      mention={mention}
      onOpen={(target) => fileMentionLinks.open(target)}
      openLabel={t('usermessage.openFile', { name: mention.name })}
    />
  )
  let offset = 0
  return (
    <>
      {unplaced.length > 0 && (
        <p className="user-message-mentions">
          {unplaced.map((mention) => chip(mention, `unplaced:${mention.path}`))}
        </p>
      )}
      <div className="node-body">
        {parts.map((part) => {
          const key = offset
          offset += typeof part === 'string' ? part.length : 1
          return typeof part === 'string' ? part : chip(part, `mention:${key}`)
        })}
      </div>
    </>
  )
}

export function UserMessage({
  node,
  t,
  readAttachment,
}: {
  node: Extract<UINode, { kind: 'user' }>
  t: Translate
  readAttachment?: AttachmentReader | undefined
}) {
  const value = node.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text' && !block.reference,
    )
    .map((block) => block.text)
    .join('\n')
  if (node.origin === 'system' && node.system)
    return (
      <div className={node.system.presentation?.kind === 'child-completed' ? 'delegation-notice' : undefined}>
        <div className="system-input-status" role="status">
          {systemInputText(node.system, t) ?? value}
        </div>
        {node.system.presentation?.kind === 'child-completed' &&
          (() => {
            const data = node.system.data
            return data &&
              typeof data === 'object' &&
              !Array.isArray(data) &&
              typeof data.childKey === 'string' ? (
              <SubtaskDetailsButton childKey={data.childKey} t={t} />
            ) : null
          })()}
        {node.system && (
          <Disclosure
            variant="plain"
            className="system-input-trace"
            summary={t(
              node.system.presentation?.kind === 'child-completed'
                ? 'delegation.technical'
                : 'tool.detail.expand',
            )}
          >
            <pre className="system-input-data">{JSON.stringify(node.system.data, null, 2)}</pre>
          </Disclosure>
        )}
      </div>
    )
  return (
    <>
      <p className="node-label">{t('timeline.userLabel')}</p>
      <UserMessageImages node={node} t={t} />
      <UserMessageFiles node={node} t={t} readAttachment={readAttachment} />
      <UserMessageReferences node={node} t={t} />
      <MentionedText
        text={value}
        mentions={node.content.flatMap((block) => {
          const mention = fileMentionOf(block)
          return mention ? [mention] : []
        })}
        t={t}
      />
    </>
  )
}

export function UserMessageFiles({
  node,
  t = (key) => key,
  readAttachment,
}: {
  node: Extract<UINode, { kind: 'user' }>
  t?: Translate
  readAttachment?: AttachmentReader | undefined
}) {
  const files = node.content.filter(
    (block) =>
      block.type === 'file' ||
      storedAttachment(block) ||
      (block.type === 'resource_link' &&
        (uploadedAttachment(block.uri) || /^artifact:\/\/[a-f0-9]{64}$/u.test(block.uri))),
  )
  if (files.length === 0) return null
  const occurrences = new Map<string, number>()
  return (
    <ul className="user-message-files">
      {files.map((file) => {
        const key =
          file.type === 'file'
            ? `${file.name}:${file.mimeType}:${file.data.length}`
            : file.type === 'resource_link'
              ? file.uri
              : ''
        const occurrence = occurrences.get(key) ?? 0
        occurrences.set(key, occurrence + 1)
        return (
          <li key={`${key}:${occurrence}`} title={'name' in file ? file.name : ''}>
            {storedAttachment(file) ? (
              <AttachmentImage file={file} read={readAttachment} t={t} />
            ) : (
              <>
                <span>{'name' in file ? file.name : ''}</span>
                <small>{'mimeType' in file ? file.mimeType : ''}</small>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Under what the reader wrote: copy it back. Shown to the pointer or the keyboard. */
export function UserMessageActions({ text, t }: { text: string; t: Translate }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!text.trim()) return null
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => undefined,
    )
  }
  return (
    <span className="user-message-actions">
      <Button
        htmlType="button"
        appearance="ghost"
        size="small"
        className="turn-action"
        data-testid="user-message-copy"
        data-copied={copied ? 'true' : undefined}
        aria-label={t('usermessage.copy')}
        title={t('usermessage.copy')}
        onClick={copy}
      >
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          {copied ? (
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          ) : (
            <>
              <path d="M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
            </>
          )}
        </svg>
      </Button>
      <span className="visually-hidden" role="status">
        {copied ? t('turnactions.copied') : ''}
      </span>
    </span>
  )
}

export const userMessageText = (node: Extract<UINode, { kind: 'user' }>): string =>
  node.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text' && !block.reference,
    )
    .map((block) => block.text)
    .join('\n')

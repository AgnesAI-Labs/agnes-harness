import { uploadedAttachment } from '@agnes/protocol'
import type { ContentBlock, UINode } from '@agnes/protocol'
import { decodeSafeImage, USER_MESSAGE_IMAGE_LIMITS } from '@agnes/protocol-validation'
import { Image } from 'antd'
import { useEffect, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { UserMessageReferences } from '../reference-chips.js'

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

/**
 * 一条用户消息的全部内联图片。原生兜底与 assistant-ui 门户是两棵各渲染一份的 DOM：
 * 门户负责可见内容，兜底只是 CSS 隐藏的备份，两条路径都要带上图片，否则门户一份只剩文字。
 */
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

export function UserMessage({ node, t }: { node: Extract<UINode, { kind: 'user' }>; t: Translate }) {
  const value = node.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text' && !block.reference,
    )
    .map((block) => block.text)
    .join('\n')
  return (
    <>
      <p className="node-label">{t('timeline.userLabel')}</p>
      <UserMessageImages node={node} t={t} />
      <UserMessageFiles node={node} />
      <UserMessageReferences node={node} t={t} />
      <div className="node-body">{value}</div>
    </>
  )
}

export function UserMessageFiles({ node }: { node: Extract<UINode, { kind: 'user' }> }) {
  const files = node.content.filter(
    (block) => block.type === 'file' || (block.type === 'resource_link' && uploadedAttachment(block.uri)),
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
            <span>{'name' in file ? file.name : ''}</span>
            <small>{'mimeType' in file ? file.mimeType : ''}</small>
          </li>
        )
      })}
    </ul>
  )
}

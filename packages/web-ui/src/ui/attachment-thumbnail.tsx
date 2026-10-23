import { Image } from 'antd'
import type { ReactNode } from 'react'
import { USER_MESSAGE_IMAGE_THUMBNAIL } from '../conversation/messages/user-message.js'

/**
 * A draft image the person can open before sending it. antd's `Image` owns the preview layer
 * (zoom, rotate, arrows between images), the same one sent messages already use.
 */
export function AttachmentThumbnail({ src, alt }: { src: string; alt: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={USER_MESSAGE_IMAGE_THUMBNAIL.width}
      height={USER_MESSAGE_IMAGE_THUMBNAIL.height}
    />
  )
}

/** One preview layer for a list of drafts, so the arrows step through all of them. */
export function AttachmentThumbnailGroup({ children }: { children: ReactNode }) {
  return <Image.PreviewGroup>{children}</Image.PreviewGroup>
}

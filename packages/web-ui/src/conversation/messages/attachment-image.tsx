import type { ArtifactRef, StoredAttachment } from '@agnes/protocol'
import { Image } from 'antd'
import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../../locales/index.js'
import { Button } from '../../ui/button.js'

export type AttachmentResource = { url: string; release(): void }
/** The host binds session/lane authority. The UI never fetches an arbitrary URI or filesystem path. */
export type AttachmentReader = (artifact: ArtifactRef, signal: AbortSignal) => Promise<AttachmentResource>

export function AttachmentImage({
  file,
  read,
  t,
}: {
  file: StoredAttachment
  read?: AttachmentReader | undefined
  t: Translate
}) {
  const [preview, setPreview] = useState<string>()
  const [original, setOriginal] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [downloadRequested, setDownloadRequested] = useState(false)
  const downloadLink = useRef<HTMLAnchorElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const loadOriginal = useRef<((download?: boolean) => Promise<void>) | undefined>(undefined)
  const { artifact, thumbnail } = file.attachment
  const image = !!file.attachment.image
  const { sha256, size, mime } = artifact
  const thumbSha = thumbnail?.sha256,
    thumbSize = thumbnail?.size,
    thumbMime = thumbnail?.mime
  useEffect(() => {
    const artifact: ArtifactRef = { sha256, size, mime }
    const thumbnail: ArtifactRef | undefined =
      thumbSha !== undefined && thumbSize !== undefined && thumbMime !== undefined
        ? { sha256: thumbSha, size: thumbSize, mime: thumbMime }
        : undefined
    const controller = new AbortController()
    const resources: AttachmentResource[] = []
    let visible = false
    setPreview(undefined)
    setOriginal(undefined)
    setFailed(false)
    setBusy(false)
    const own = (resource: AttachmentResource) => {
      if (controller.signal.aborted) {
        resource.release()
        return false
      }
      resources.push(resource)
      return true
    }
    const full = async (download = false) => {
      if (!read || controller.signal.aborted) return
      setBusy(true)
      try {
        const resource = await read(artifact, controller.signal)
        if (own(resource)) {
          setOriginal(resource.url)
          setFailed(false)
          if (download) setDownloadRequested(true)
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    }
    loadOriginal.current = full
    const load = async () => {
      if (visible || !read || !image) return
      visible = true
      // Small historical images can preview the original; large images wait for an explicit click.
      const ref = thumbnail ?? (artifact.size <= 8 * 1024 * 1024 ? artifact : undefined)
      if (!ref) return
      try {
        const resource = await read(ref, controller.signal)
        if (own(resource)) setPreview(resource.url)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    }
    const observer =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer?.disconnect()
              void load()
            }
          })
        : undefined
    if (observer && host.current) observer.observe(host.current)
    else void load()
    return () => {
      controller.abort()
      observer?.disconnect()
      loadOriginal.current = undefined
      for (const resource of resources) resource.release()
    }
  }, [read, sha256, size, mime, thumbSha, thumbSize, thumbMime, image])
  useEffect(() => {
    if (original && downloadRequested) {
      downloadLink.current?.click()
      setDownloadRequested(false)
    }
  }, [original, downloadRequested])
  const src = original ?? preview
  return (
    <div ref={host} className="user-message-attachment" data-testid="stored-attachment">
      {image && src && (
        <Image
          className="user-message-image"
          src={src}
          alt={file.name}
          width={72}
          height={56}
          preview={{
            onOpenChange: (open) => {
              if (open && !original && !busy) void loadOriginal.current?.()
            },
          }}
        />
      )}
      <span>{file.name}</span>
      <small>
        {file.mimeType} · {artifact.size.toLocaleString()} B
      </small>
      {failed && (
        <span className="user-message-image-unavailable" role="status">
          {t('conversation.imageUnavailable')}
        </span>
      )}
      <a ref={downloadLink} href={original} download={file.name} hidden={!original}>
        {t('conversation.downloadOriginal')}
      </a>
      {!original && (
        <Button
          size="small"
          disabled={!read || busy}
          onClick={() => {
            void loadOriginal.current?.(true)
          }}
        >
          {t('conversation.downloadOriginal')}
        </Button>
      )}
    </div>
  )
}

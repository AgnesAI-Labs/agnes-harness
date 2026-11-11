import { decodeSafeImage } from '@agnes/protocol-validation'
import { useEffect, useState } from 'react'
import { Icon } from './icon.js'

const limits = {
  maxBytesPerImage: 24 * 1024,
  maxAggregateBytes: 24 * 1024,
  maxPixelsPerImage: 1024 * 1024,
  maxAggregatePixels: 1024 * 1024,
}

/** Decorative plugin artwork; never fetch arbitrary plugin URLs or relax the image CSP. */
export function ChannelIcon({ icon, className }: { icon?: string | undefined; className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <ChannelArtwork key={icon ?? ''} icon={icon} />
    </span>
  )
}

function ChannelArtwork({ icon }: { icon?: string | undefined }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!icon || icon.length > 32768) return
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(icon)
    if (!match?.[1] || !match[2]) return
    let objectUrl: string
    try {
      const decoded = decodeSafeImage({ data: match[2], mimeType: match[1] }, limits)
      const bytes = new ArrayBuffer(decoded.bytes.byteLength)
      new Uint8Array(bytes).set(decoded.bytes)
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: decoded.mime }))
      setUrl(objectUrl)
    } catch {
      return
    }
    return () => URL.revokeObjectURL(objectUrl)
  }, [icon])
  return url && !failed ? (
    <img src={url} alt="" width={28} height={28} onError={() => setFailed(true)} />
  ) : (
    <Icon name="message-square" size={20} />
  )
}

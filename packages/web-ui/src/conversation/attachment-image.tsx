import { createContext, useContext, useEffect, useState } from 'react'

/** One window of a session attachment's bytes, located like `session-image://<seq>/<index>`. */
export type AttachmentWindowReader = (
  input: {
    seq: number
    kind: 'image' | 'file'
    index: number
    offset: number
    length: number
    thumbnail?: boolean
  },
  signal?: AbortSignal,
) => Promise<{ mimeType: string; totalBytes: number; base64: string }>

/** The host's reader for the open session; without one, referenced images show their name and size. */
export const AttachmentReaderContext = createContext<AttachmentWindowReader | undefined>(undefined)

const WINDOW = 1024 * 1024
/** A referenced image without a thumbnail is fetched whole only up to this size. */
export const REFERENCE_IMAGE_FETCH_MAX_BYTES = 8 * 1024 * 1024

type ReferenceImage = {
  mimeType: string
  attachment: { sha256: string; bytes: number }
  thumbnail?: { sha256: string; bytes: number; width: number; height: number }
}

export type ReferenceImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'unavailable' }
  /** Too large to fetch for display and no thumbnail: shown by name and size. */
  | { status: 'large' }

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function fetchImage(
  read: AttachmentWindowReader,
  o: { seq: number; index: number; mimeType: string; bytes: number; thumbnailBytes: number | undefined },
  signal: AbortSignal,
): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let mimeType = o.mimeType
  if (o.thumbnailBytes !== undefined) {
    const page = await read(
      { seq: o.seq, kind: 'image', index: o.index, offset: 0, length: o.thumbnailBytes, thumbnail: true },
      signal,
    )
    parts.push(decode(page.base64))
    mimeType = page.mimeType
  } else
    for (let offset = 0; offset < o.bytes; ) {
      const page = await read(
        { seq: o.seq, kind: 'image', index: o.index, offset, length: Math.min(WINDOW, o.bytes - offset) },
        signal,
      )
      const part = decode(page.base64)
      if (part.length === 0) throw new Error('attachment window is empty')
      parts.push(part)
      offset += part.length
    }
  return new Blob(parts, { type: mimeType })
}

type Shared = { blob: Promise<Blob>; users: number; abort: AbortController }
const shared = new WeakMap<AttachmentWindowReader, Map<string, Shared>>()

/**
 * One fetch per image and reader, however many places show it (a message renders in two trees): the
 * bytes are shared until the last place lets go, which cancels a fetch still running.
 */
function fetchShared(
  read: AttachmentWindowReader,
  key: string,
  fetch: (signal: AbortSignal) => Promise<Blob>,
): { blob: Promise<Blob>; done(): void } {
  let byKey = shared.get(read)
  if (!byKey) {
    byKey = new Map()
    shared.set(read, byKey)
  }
  let entry = byKey.get(key)
  if (!entry) {
    const abort = new AbortController()
    entry = { blob: fetch(abort.signal), users: 0, abort }
    entry.blob.catch(() => byKey?.delete(key))
    byKey.set(key, entry)
  }
  const held = entry
  held.users++
  let released = false
  return {
    blob: held.blob,
    done() {
      if (released) return
      released = true
      if (--held.users > 0) return
      held.abort.abort()
      if (byKey?.get(key) === held) byKey.delete(key)
    },
  }
}

/**
 * A referenced image as a `blob:` URL (the page's content policy allows no `data:` images): its
 * thumbnail in one read when it has one, otherwise the original in 1 MiB windows up to 8 MiB. The URL
 * is revoked when the image leaves the page.
 */
export function useReferenceImage(
  image: ReferenceImage,
  at: { seq: number; index: number },
  read: AttachmentWindowReader | undefined,
): ReferenceImageState {
  const thumbnailBytes = image.thumbnail?.bytes
  const large = thumbnailBytes === undefined && image.attachment.bytes > REFERENCE_IMAGE_FETCH_MAX_BYTES
  const [state, setState] = useState<ReferenceImageState>(
    large ? { status: 'large' } : read ? { status: 'loading' } : { status: 'unavailable' },
  )
  const { seq, index } = at
  const { sha256, bytes } = image.attachment
  useEffect(() => {
    if (large) {
      setState({ status: 'large' })
      return
    }
    if (!read) {
      setState({ status: 'unavailable' })
      return
    }
    let cancelled = false
    let url: string | undefined
    const key = `${seq}/${index}/${sha256}/${thumbnailBytes ?? 'original'}`
    const release = fetchShared(read, key, (signal) =>
      fetchImage(read, { seq, index, mimeType: image.mimeType, bytes, thumbnailBytes }, signal),
    )
    release.blob.then(
      (blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setState({ status: 'ready', url })
      },
      () => {
        if (!cancelled) setState({ status: 'unavailable' })
      },
    )
    return () => {
      cancelled = true
      release.done()
      if (url) URL.revokeObjectURL(url)
    }
  }, [large, read, seq, index, sha256, bytes, thumbnailBytes, image.mimeType])
  return state
}

export function useAttachmentReader(): AttachmentWindowReader | undefined {
  return useContext(AttachmentReaderContext)
}

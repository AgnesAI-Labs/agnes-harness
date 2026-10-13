import { type ContentBlock, USER_ATTACHMENT_THUMBNAIL } from '@agnes/protocol'

export type UploadedThumbnail = { sha256: string; bytes: number; width: number; height: number }
export type ComposerUploadInput = {
  bytes: Blob
  name: string
  mimeType: string
  purpose?: 'attachment' | 'thumbnail'
}
export type ComposerUploadCallOptions = {
  onProgress?(sent: number, total: number): void
  signal?: AbortSignal
  uploadId?: string
}

/** One session's upload channel, as the host opened it for the attachments being added. */
export type ComposerUploadTarget = Readonly<{
  /** The session every upload through this target belongs to; only that session may send them. */
  sessionId: string
  /** The largest single upload the server accepts. */
  maxBytes: number
  /** Uploads run at once. */
  maxConcurrent: number
  /** Uploads one object; a failure carries `uploadId`, and passing it back resumes the upload. */
  upload(input: ComposerUploadInput, o: ComposerUploadCallOptions): Promise<ContentBlock | UploadedThumbnail>
  /** Tells the server to drop an upload it holds (a failed one the user removed). */
  cancel?(uploadId: string): Promise<void>
}>

/**
 * How the composer reaches the upload channel. `open` answers a target for the open session;
 * `'deferred'` when the server takes uploads but no session exists yet (the files wait, unread, until
 * the send creates one); undefined when attachments go inline.
 */
export type ComposerUploadChannel = Readonly<{
  open(): Promise<ComposerUploadTarget | 'deferred' | undefined>
}>

export type ComposerUploadStatus = 'waiting' | 'uploading' | 'ready' | 'failed' | 'cancelled'
export type ComposerUploadEntry = Readonly<{
  id: string
  name: string
  status: ComposerUploadStatus
  sent: number
  total: number
  error?: unknown
  /** The reference block to send, once ready; an image carries its thumbnail when one was made. */
  block?: ContentBlock
}>

type Job = {
  id: string
  file: Blob
  name: string
  mimeType: string
  image: boolean
  /** Absent while the upload waits for a session to be created. */
  target?: ComposerUploadTarget
  status: ComposerUploadStatus
  sent: number
  /** Bytes of the attachment: the file's size, or a restored reference's. */
  size?: number
  error?: unknown
  uploadId?: string | undefined
  reference?: ContentBlock
  block?: ContentBlock
  abort?: AbortController | undefined
}

/**
 * A thumbnail for an uploaded image, made in the page: the longest edge at most 320 pixels, JPEG at
 * quality 0.8, and at 0.6 when that is over 256 KiB. Undefined when the browser cannot draw the image or
 * the thumbnail is still too large; the image is then sent without one.
 */
export async function makeImageThumbnail(file: Blob): Promise<Blob | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return undefined
  }
  try {
    const ratio = Math.min(1, USER_ATTACHMENT_THUMBNAIL.maxEdge / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [USER_ATTACHMENT_THUMBNAIL.jpegQuality, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (blob && blob.size <= USER_ATTACHMENT_THUMBNAIL.maxBytes) return blob
    }
    return undefined
  } finally {
    bitmap.close()
  }
}

/** A restored attachment is already uploaded; it never uploads again. */
const RESTORED: ComposerUploadTarget = {
  sessionId: '',
  maxBytes: 0,
  maxConcurrent: 1,
  upload: () => Promise.reject(new Error('already uploaded')),
}

/**
 * The block as the composer sends it. A PNG or JPEG added while the model takes no images is sent as
 * a file: the server answers an image reference for one, which such a model would refuse.
 */
function asSent(job: { image: boolean; name: string }, block: ContentBlock): ContentBlock {
  if (job.image || block.type !== 'image' || !('attachment' in block)) return block
  return {
    type: 'file',
    mimeType: block.mimeType,
    name: job.name,
    attachment: block.attachment,
  } as ContentBlock
}

const uploadIdOf = (error: unknown): string | undefined => {
  const id = (error as { uploadId?: unknown } | null)?.uploadId
  return typeof id === 'string' ? id : undefined
}

/**
 * The composer's uploads: each attachment is uploaded on its own (images with a thumbnail), at most
 * `maxConcurrent` at once, with progress, cancel and retry. A retry resumes from the server's offset.
 */
export function createComposerUpload(deps: {
  makeThumbnail?(file: Blob): Promise<Blob | undefined>
  onChange(): void
  /** Told once each time an attachment's upload fails. */
  onFailed?(entry: ComposerUploadEntry): void
}) {
  const jobs = new Map<string, Job>()
  const running = () => [...jobs.values()].filter((job) => job.status === 'uploading').length
  const view = (job: Job): ComposerUploadEntry => ({
    id: job.id,
    name: job.name,
    status: job.status,
    sent: job.sent,
    total: job.size ?? job.file.size,
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.block ? { block: job.block } : {}),
  })
  const pump = () => {
    for (const job of jobs.values()) {
      if (job.status !== 'waiting' || !job.target) continue
      if (running() >= job.target.maxConcurrent) break
      void run(job, job.target)
    }
  }
  const settled = new Set<() => void>()
  const notify = () => {
    deps.onChange()
    for (const listener of [...settled]) listener()
  }
  const thumbnail = async (
    job: Job,
    target: ComposerUploadTarget,
    signal: AbortSignal,
  ): Promise<UploadedThumbnail | undefined> => {
    const blob = await deps.makeThumbnail?.(job.file)
    if (!blob || signal.aborted) return undefined
    try {
      return (await target.upload(
        { bytes: blob, name: 'thumbnail.jpg', mimeType: 'image/jpeg', purpose: 'thumbnail' },
        { signal },
      )) as UploadedThumbnail
    } catch (error) {
      if (signal.aborted) throw error
      // A thumbnail is only a convenience for display: the image goes without one.
      return undefined
    }
  }
  const run = async (job: Job, target: ComposerUploadTarget) => {
    const abort = new AbortController()
    job.abort = abort
    job.status = 'uploading'
    job.error = undefined
    deps.onChange()
    try {
      job.reference ??= asSent(
        job,
        (await target.upload(
          { bytes: job.file, name: job.name, mimeType: job.mimeType },
          {
            signal: abort.signal,
            ...(job.uploadId ? { uploadId: job.uploadId } : {}),
            onProgress: (sent) => {
              job.sent = sent
              deps.onChange()
            },
          },
        )) as ContentBlock,
      )
      job.sent = job.file.size
      const thumb =
        job.image && job.reference.type === 'image' ? await thumbnail(job, target, abort.signal) : undefined
      abort.signal.throwIfAborted()
      job.block = thumb ? ({ ...job.reference, thumbnail: thumb } as ContentBlock) : job.reference
      job.status = 'ready'
    } catch (error) {
      // Cancelled while it ran: the entry is gone and stays gone.
      if ((job.status as ComposerUploadStatus) === 'cancelled') return
      job.uploadId = job.reference ? job.uploadId : (uploadIdOf(error) ?? job.uploadId)
      job.status = 'failed'
      job.error = error
      deps.onFailed?.(view(job))
    } finally {
      if (job.abort === abort) job.abort = undefined
      notify()
      pump()
    }
  }
  return {
    /**
     * Queues one attachment; it starts when a slot is free. Without a target it waits, unread, for
     * `uploadDeferred` to name the session it belongs to.
     */
    add(
      id: string,
      input: { file: Blob; name: string; mimeType: string; image: boolean },
      target: ComposerUploadTarget | undefined,
    ) {
      jobs.set(id, { id, ...input, ...(target ? { target } : {}), status: 'waiting', sent: 0 })
      deps.onChange()
      pump()
    },
    /** Attachments waiting for a session to be created before they upload. */
    deferred(): string[] {
      return [...jobs.values()].filter((job) => !job.target).map((job) => job.id)
    },
    /**
     * Uploads every waiting attachment into the session `target` names, and settles once each one is
     * ready (or rejects with the first failure; the failed ones stay, with their Retry).
     */
    async uploadDeferred(target: ComposerUploadTarget): Promise<void> {
      const waiting = [...jobs.values()].filter((job) => !job.target)
      for (const job of waiting) job.target = target
      pump()
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const live = waiting.filter((job) => jobs.get(job.id) === job)
          const failed = live.find((job) => job.status === 'failed')
          if (failed) {
            settled.delete(check)
            reject(failed.error ?? new Error(`${failed.name} could not be uploaded`))
          } else if (live.every((job) => job.status === 'ready')) {
            settled.delete(check)
            resolve()
          }
        }
        settled.add(check)
        check()
      })
    },
    /** The file an entry holds, for sending it inline where no upload is possible. */
    file(id: string): Blob | undefined {
      return jobs.get(id)?.file
    },
    /** The session an entry was uploaded into, if any. */
    sessionOf(id: string): string | undefined {
      return jobs.get(id)?.target?.sessionId
    },
    /** An attachment uploaded before (a send that failed gives its blocks back): ready as it is. */
    restore(id: string, block: ContentBlock, name: string, bytes: number) {
      jobs.set(id, {
        id,
        file: new Blob([]),
        name,
        mimeType: (block as { mimeType: string }).mimeType,
        image: block.type === 'image',
        target: RESTORED,
        status: 'ready',
        sent: bytes,
        reference: block,
        block,
        size: bytes,
      })
      deps.onChange()
    },
    entry(id: string): ComposerUploadEntry | undefined {
      const job = jobs.get(id)
      return job ? view(job) : undefined
    },
    entries(): ComposerUploadEntry[] {
      return [...jobs.values()].map(view)
    },
    /**
     * True while any attachment is not uploaded yet, a failed one included: it must be retried or
     * removed. One waiting for a session to be created is not pending: the send uploads it.
     */
    pending(): boolean {
      return [...jobs.values()].some(
        (job) => job.target !== undefined && job.status !== 'ready' && job.status !== 'cancelled',
      )
    },
    /** Uploads a failed attachment again, from where the server holds it. */
    retry(id: string) {
      const job = jobs.get(id)
      if (job?.status !== 'failed') return
      job.status = 'waiting'
      deps.onChange()
      pump()
    },
    /** Stops an attachment's upload (the server drops what it holds) and forgets it. */
    cancel(id: string) {
      const job = jobs.get(id)
      if (!job) return
      const failed = job.status === 'failed'
      job.status = 'cancelled'
      jobs.delete(id)
      job.abort?.abort()
      // A failed upload is still held by the server (its staging file and quota room); give it back.
      if (failed && job.uploadId && !job.reference)
        void job.target?.cancel?.(job.uploadId).catch(() => undefined)
      notify()
      pump()
    },
    cancelAll() {
      for (const id of [...jobs.keys()]) this.cancel(id)
    },
  }
}

export type ComposerUpload = ReturnType<typeof createComposerUpload>

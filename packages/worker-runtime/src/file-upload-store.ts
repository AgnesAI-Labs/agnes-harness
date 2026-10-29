import { createHash } from 'node:crypto'
import { close, fstat, fsync, ftruncate, read, write } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  FILE_UPLOAD_CHUNK_BYTES,
  type FileUploadRequest,
  type FileUploadResult,
  type UploadLimits,
} from '@agnes/protocol'
import { canonicalFs, openCanonicalFileSync, openCanonicalWritableFileSync } from '@agnes/system-node'

export class UploadError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
const fail = (code: string): never => {
  throw new UploadError(code)
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ID = /^[a-f0-9-]{36}$/u
const SHA = /^[a-f0-9]{64}$/u
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu
type Fs = {
  authorizeWrite?(path: string): Promise<void>
  authorizeRemove?(path: string, opts?: { recursive?: boolean }): Promise<void>
  rm?(path: string, opts?: { recursive?: boolean }): Promise<void>
  write(path: string, bytes: Uint8Array): Promise<void>
  stat(path: string): Promise<unknown>
  list(path: string): Promise<{ name: string }[]>
}
type Upload = {
  id: string
  name: string
  mimeType: string
  size: number
  offset: number
  path: string
  cancelled: boolean
  tail: Promise<unknown>
  touched: number
  busy: boolean
  final?: string
  attachment?: NonNullable<FileUploadResult['attachment']>
}

export function configuredUploadLimits(env = process.env): UploadLimits {
  const maxBytes = Number(env.AGH_UPLOAD_MAX_BYTES ?? 2 * 1024 * 1024 * 1024)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid AGH_UPLOAD_MAX_BYTES')
  const allowedMimeTypes = (env.AGH_UPLOAD_MIME_TYPES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowedMimeTypes.length > 256 || allowedMimeTypes.some((type) => type.length > 128 || !MIME.test(type)))
    throw new Error('Invalid AGH_UPLOAD_MIME_TYPES')
  return { maxBytes, chunkBytes: FILE_UPLOAD_CHUNK_BYTES, allowedMimeTypes }
}

/** Session-owned bounded intake. Filesystem writes first pass through the workspace Fs capability. */
export class FileUploadStore {
  private uploads = new Map<string, Upload>()
  private timer: ReturnType<typeof setInterval>
  private cancelled = new Map<string, number>()
  private closed = false
  private recovery?: Promise<void>
  private starting = new Map<string, Promise<FileUploadResult>>()
  constructor(
    readonly sessionId: string,
    readonly limits: UploadLimits = configuredUploadLimits(),
  ) {
    this.timer = setInterval(() => {
      void this.expire().catch(() => undefined)
    }, 60_000)
    this.timer.unref?.()
  }

  async request(input: FileUploadRequest, root: string, fs: Fs): Promise<FileUploadResult> {
    if (this.closed) return fail('UPLOAD_CLOSED')
    if (!fs.authorizeWrite) return fail('UPLOAD_WORKSPACE_DENIED')
    if (input.operation === 'limits') return { limits: this.limits }
    if (typeof input.uploadId !== 'string' || !ID.test(input.uploadId)) return fail('UPLOAD_INVALID')
    if (input.operation === 'cancel' && !this.cancelled.has(input.uploadId) && this.cancelled.size >= 1000)
      return fail('UPLOAD_BUSY')
    if (input.operation === 'start') {
      if (this.cancelled.has(input.uploadId)) return fail('UPLOAD_CANCELLED')
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > this.limits.maxBytes)
        return fail('UPLOAD_SIZE_LIMIT')
      if (
        typeof input.name !== 'string' ||
        !input.name ||
        input.name.length > 256 ||
        [...input.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        return fail('UPLOAD_NAME_INVALID')
      if (
        typeof input.mimeType !== 'string' ||
        !MIME.test(input.mimeType) ||
        input.mimeType.length > 128 ||
        (this.limits.allowedMimeTypes.length > 0 && !this.limits.allowedMimeTypes.includes(input.mimeType))
      )
        return fail('UPLOAD_TYPE_LIMIT')
      const starting = this.starting.get(input.uploadId)
      if (starting) {
        await starting
        return this.request(input, root, fs)
      }
      const existing = this.uploads.get(input.uploadId)
      if (existing) {
        if (
          existing.name !== input.name ||
          existing.size !== input.size ||
          existing.mimeType !== input.mimeType
        )
          return fail('UPLOAD_INVALID')
        return {
          offset: existing.offset,
          ...(existing.attachment ? { attachment: existing.attachment } : {}),
        }
      }
      if (
        [...this.uploads.values()].filter((u) => !u.attachment).length + this.starting.size >= 4 ||
        this.uploads.size >= 100
      )
        return fail('UPLOAD_BUSY')
      const directory = join(root, '.agnes-attachments', hash(Buffer.from(this.sessionId)))
      const path = join(directory, `.partial-${input.uploadId}`)
      // Fs.write enforces the session's canonical/private-root policy before any native append.
      const pending = (async (): Promise<FileUploadResult> => {
        const upload: Upload = {
          id: input.uploadId,
          name: input.name,
          mimeType: input.mimeType,
          size: input.size,
          offset: 0,
          path,
          cancelled: false,
          tail: Promise.resolve(),
          touched: Date.now(),
          busy: false,
        }
        try {
          try {
            await fs.stat(join(directory, input.uploadId))
            return fail('UPLOAD_INVALID')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await fs.write(path, new Uint8Array())
          await this.safe(path, root, fs)
          if (this.closed || this.cancelled.has(input.uploadId)) return fail('UPLOAD_CANCELLED')
          this.uploads.set(input.uploadId, upload)
          return { offset: 0 }
        } catch (error) {
          await this.cleanupTemporary(upload)
          throw error
        }
      })()
      this.starting.set(input.uploadId, pending)
      try {
        return await pending
      } finally {
        this.starting.delete(input.uploadId)
      }
    }
    await this.starting.get(input.uploadId)
    const upload = this.uploads.get(input.uploadId)
    if (!upload) {
      if (input.operation === 'cancel') {
        // The memory record is gone after a restart or cache eviction. The receipt directory is durable.
        if (await this.published(input.uploadId, root, fs)) return fail('UPLOAD_ALREADY_PUBLISHED')
        await this.cancelFiles(input.uploadId, root, fs)
        this.cancelled.set(input.uploadId, Date.now())
        return {}
      }
      return fail('UPLOAD_NOT_FOUND')
    }
    const writes = input.operation === 'chunk' || input.operation === 'finish'
    if (writes && upload.busy) return fail('UPLOAD_BUSY')
    if (writes) upload.busy = true
    const work = upload.tail
      .catch(() => undefined)
      .then(async () => {
        if (input.operation === 'cancel') {
          if (upload.attachment || (await this.published(input.uploadId, root, fs)))
            return fail('UPLOAD_ALREADY_PUBLISHED')
          await this.cancelFiles(input.uploadId, root, fs)
          upload.cancelled = true
          this.cancelled.set(input.uploadId, Date.now())
          this.uploads.delete(input.uploadId)
          return {}
        }
        upload.touched = Date.now()
        if (upload.cancelled) return fail('UPLOAD_CANCELLED')
        if (input.operation === 'status')
          return { offset: upload.offset, ...(upload.attachment ? { attachment: upload.attachment } : {}) }
        if (upload.attachment) return { offset: upload.offset, attachment: upload.attachment }
        let file: ReturnType<typeof uploadFile> | undefined
        try {
          await fs.authorizeWrite?.(upload.path)
          await this.safe(upload.path, root, fs)
          file = uploadFile(upload.path, input.operation === 'chunk')
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== upload.offset)
            return fail('UPLOAD_UNAVAILABLE')
          if (input.operation === 'chunk') {
            if (
              !Number.isSafeInteger(input.offset) ||
              input.offset < 0 ||
              !SHA.test(input.sha256) ||
              typeof input.data !== 'string' ||
              input.data.length > Math.ceil(this.limits.chunkBytes / 3) * 4
            )
              return fail('UPLOAD_INVALID')
            const bytes = Buffer.from(input.data, 'base64')
            if (
              bytes.length === 0 ||
              bytes.length > this.limits.chunkBytes ||
              bytes.toString('base64') !== input.data
            )
              return fail('UPLOAD_CHUNK_LIMIT')
            if (hash(bytes) !== input.sha256) return fail('UPLOAD_HASH_MISMATCH')
            if (input.offset < upload.offset && input.offset + bytes.length <= upload.offset) {
              const old = Buffer.alloc(bytes.length)
              const reader = uploadFile(upload.path, false)
              try {
                let read = 0
                while (read < old.length) {
                  const { bytesRead } = await reader.read(old, read, old.length - read, input.offset + read)
                  if (bytesRead === 0) return fail('UPLOAD_INCOMPLETE')
                  read += bytesRead
                }
              } finally {
                await reader.close()
              }
              if (hash(old) !== input.sha256) return fail('UPLOAD_OFFSET_MISMATCH')
              return { offset: upload.offset }
            }
            if (input.offset !== upload.offset || upload.offset + bytes.length > upload.size)
              return fail('UPLOAD_OFFSET_MISMATCH')
            // One chunk is live at a time. No concatenation, stream prefetch or full-file read.
            let written = 0
            while (written < bytes.length) {
              if (upload.cancelled) return fail('UPLOAD_CANCELLED')
              const result = await file.write(bytes, written, bytes.length - written, upload.offset + written)
              if (result.bytesWritten === 0) return fail('UPLOAD_UNAVAILABLE')
              written += result.bytesWritten
            }
            await file.sync()
            upload.offset += bytes.length
            return { offset: upload.offset }
          }
          if (input.operation !== 'finish' || upload.offset !== upload.size || !SHA.test(input.sha256))
            return fail('UPLOAD_INCOMPLETE')
          const digest = createHash('sha256')
          const buffer = Buffer.alloc(64 * 1024)
          for (let at = 0; at < upload.size; ) {
            if (upload.cancelled) return fail('UPLOAD_CANCELLED')
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, upload.size - at), at)
            if (bytesRead === 0) return fail('UPLOAD_INCOMPLETE')
            digest.update(buffer.subarray(0, bytesRead))
            at += bytesRead
          }
          if (digest.digest('hex') !== input.sha256) return fail('UPLOAD_HASH_MISMATCH')
          if (upload.cancelled) return fail('UPLOAD_CANCELLED')
          // A unique receipt directory keeps cancellation independent even for duplicate contents.
          // The artifact's basename is its verified content address, never the client filename.
          const final = join(
            root,
            '.agnes-attachments',
            hash(Buffer.from(this.sessionId)),
            upload.id,
            input.sha256,
          )
          upload.final = final
          await fs.write(final, new Uint8Array())
          await this.safe(final, root, fs)
          // Both descriptors refuse symlink ancestors. Avoid path-based rename after authorization,
          // which could follow a directory replaced concurrently by a workspace process.
          const published = uploadFile(final, true)
          try {
            const copied = createHash('sha256')
            const info = await published.stat()
            if (!info.isFile() || info.nlink !== 1 || info.size !== 0) return fail('UPLOAD_PATH_DENIED')
            for (let at = 0; at < upload.size; ) {
              if (upload.cancelled) return fail('UPLOAD_CANCELLED')
              const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, upload.size - at), at)
              if (bytesRead === 0) return fail('UPLOAD_INCOMPLETE')
              copied.update(buffer.subarray(0, bytesRead))
              let written = 0
              while (written < bytesRead) {
                const { bytesWritten } = await published.write(
                  buffer,
                  written,
                  bytesRead - written,
                  at + written,
                )
                if (bytesWritten === 0) return fail('UPLOAD_UNAVAILABLE')
                written += bytesWritten
              }
              at += bytesRead
            }
            if (copied.digest('hex') !== input.sha256) return fail('UPLOAD_HASH_MISMATCH')
            await published.sync()
          } finally {
            await published.close()
          }
          if (upload.cancelled) return fail('UPLOAD_CANCELLED')
          await file.close()
          await canonicalFs('rm', upload.path)
          upload.attachment = {
            type: 'resource_link',
            uri: `agnes-upload://${hash(Buffer.from(this.sessionId))}/${input.sha256}/${upload.size}/${upload.id}`,
            name: upload.name,
            mimeType: upload.mimeType,
          }
          return { offset: upload.offset, attachment: upload.attachment }
        } catch (error) {
          if (error instanceof UploadError && error.code === 'UPLOAD_PATH_DENIED') throw error
          if (input.operation === 'chunk') await file?.truncate(upload.offset).catch(() => undefined)
          if (
            input.operation === 'finish' ||
            !(error instanceof UploadError) ||
            ['UPLOAD_UNAVAILABLE', 'UPLOAD_INCOMPLETE'].includes(error.code)
          ) {
            await file?.close().catch(() => undefined)
            await this.cleanupTemporary(upload)
          }
          throw error
        } finally {
          await file?.close().catch(() => undefined)
        }
      })
    upload.tail = work
    try {
      return await work
    } finally {
      if (writes) upload.busy = false
    }
  }

  /** A new session handle discards interrupted intake, retaining only published artifacts. */
  recover(root: string, fs: Fs): Promise<void> {
    this.recovery ??= (async () => {
      const directory = join(root, '.agnes-attachments', hash(Buffer.from(this.sessionId)))
      let entries: { name: string }[]
      try {
        entries = await fs.list(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (!/^\.partial-[a-f0-9-]{36}$/u.test(entry.name)) continue
        const path = join(directory, entry.name)
        await this.safe(path, root, fs)
        // A crash during bounded publication may leave both the partial and its receipt directory.
        await canonicalFs('rm', join(directory, entry.name.slice('.partial-'.length)), true).catch(
          (error) => {
            if (error.code !== 'ENOENT') throw error
          },
        )
        await canonicalFs('rm', path)
      }
    })()
    return this.recovery
  }

  private async safe(path: string, root: string, fs: Fs): Promise<void> {
    await fs.stat(path)
    let current = root
    for (const part of path.slice(root.length + 1).split('/')) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) return fail('UPLOAD_PATH_DENIED')
    }
    if ((await realpath(path)) !== path) return fail('UPLOAD_PATH_DENIED')
  }
  /** A finished upload has dropped its partial and left a content-addressed receipt. */
  private async published(id: string, root: string, fs: Fs): Promise<boolean> {
    const directory = join(root, '.agnes-attachments', hash(Buffer.from(this.sessionId)))
    try {
      await fs.stat(join(directory, `.partial-${id}`))
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      const entries = await fs.list(join(directory, id))
      return entries.some((entry) => SHA.test(entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }
  /** Caller cancellation never borrows the maintenance cleanup authority. */
  private async cancelFiles(id: string, root: string, fs: Fs): Promise<void> {
    if (!fs.authorizeRemove || !fs.rm) return fail('UPLOAD_WORKSPACE_DENIED')
    const directory = join(root, '.agnes-attachments', hash(Buffer.from(this.sessionId)))
    const paths = [
      { path: join(directory, `.partial-${id}`), recursive: false },
      { path: join(directory, id), recursive: true },
    ]
    // Check every target (including absent leaves) before deleting bytes or recording cancellation.
    for (const { path, recursive } of paths) await fs.authorizeRemove(path, { recursive })
    for (const { path, recursive } of paths) {
      try {
        await this.safe(path, root, fs)
        await fs.rm(path, { recursive })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  /** Session-owned interrupted intake only; never invoked by caller cancellation. */
  private async cleanupTemporary(upload: Upload): Promise<void> {
    await canonicalFs('rm', upload.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (upload.final)
      await canonicalFs('rm', dirname(upload.final), true).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    this.uploads.delete(upload.id)
  }
  private async expire(): Promise<void> {
    for (const [id, touched] of this.cancelled)
      if (Date.now() - touched > 30 * 60_000) this.cancelled.delete(id)
    for (const upload of this.uploads.values()) {
      if (Date.now() - upload.touched > 30 * 60_000 && upload.attachment) this.uploads.delete(upload.id)
      else if (!upload.attachment && Date.now() - upload.touched > 30 * 60_000) {
        upload.cancelled = true
        await upload.tail.catch(() => undefined)
        await this.cleanupTemporary(upload)
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await Promise.allSettled(this.starting.values())
    for (const upload of this.uploads.values()) {
      if (upload.attachment) continue
      upload.cancelled = true
      await upload.tail.catch(() => undefined)
      await this.cleanupTemporary(upload)
    }
  }
}

const closeFd = promisify(close),
  statFd = promisify(fstat),
  syncFd = promisify(fsync)
const readFd = promisify(read),
  writeFd = promisify(write),
  truncateFd = promisify(ftruncate)
function uploadFile(path: string, writable: boolean) {
  const fd = writable ? openCanonicalWritableFileSync(path) : openCanonicalFileSync(path)
  let closed = false
  return {
    stat: () => statFd(fd),
    sync: () => syncFd(fd),
    truncate: (size: number) => truncateFd(fd, size),
    read: (bytes: Buffer, offset: number, length: number, position: number) =>
      readFd(fd, bytes, offset, length, position),
    write: (bytes: Buffer, offset: number, length: number, position: number) =>
      writeFd(fd, bytes, offset, length, position),
    close: async () => {
      if (!closed) {
        closed = true
        await closeFd(fd)
      }
    },
  }
}

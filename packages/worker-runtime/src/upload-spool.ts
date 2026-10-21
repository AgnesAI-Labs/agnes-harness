import { closeSync } from 'node:fs'
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

/** Private, session-owned intake; never a workspace path or a published artifact. */
export class UploadSpool {
  private constructor(
    private root: string,
    private file: FileHandle,
  ) {}
  static async create() {
    const root = await mkdtemp(join(tmpdir(), 'agh-upload-'))
    try {
      const directory = join(root, 'private')
      // Node modes do not establish a private Windows DACL. Harden before creating byte files.
      createPrivateDirectorySync(directory)
      const path = join(directory, 'bytes')
      // Establish the file's own protected DACL too; Node's mode only applies on POSIX.
      closeSync(createPrivateFileSync(path))
      return new UploadSpool(root, await open(path, 'r+'))
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
  async append(bytes: Uint8Array, offset: number) {
    let at = 0
    try {
      while (at < bytes.length) {
        const { bytesWritten } = await this.file.write(bytes, at, bytes.length - at, offset + at)
        if (!bytesWritten) throw new Error('Upload spool write failed')
        at += bytesWritten
      }
    } catch (error) {
      // A partial write is not acknowledged; the same offset can be retried safely.
      await this.file.truncate(offset)
      throw error
    }
  }
  async *source(size: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const buffer = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < size; ) {
      signal.throwIfAborted()
      const { bytesRead } = await this.file.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (!bytesRead) throw new Error('Incomplete upload spool')
      offset += bytesRead
      yield buffer.subarray(0, bytesRead)
    }
    signal.throwIfAborted()
  }
  async bytes(size: number, signal: AbortSignal) {
    const result = new Uint8Array(size)
    let offset = 0
    for await (const chunk of this.source(size, signal)) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
  async close() {
    try {
      await this.file.close()
    } finally {
      await rm(this.root, { recursive: true, force: true })
    }
  }
}

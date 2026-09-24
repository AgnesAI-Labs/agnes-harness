import { Duplex } from 'node:stream'

const BLOCK_BYTES = 64 * 1024

/** Internal native contract: close cancels I/O and settles only after releasing the pipe. */
export interface OwnedPipe {
  read(): Promise<Buffer | null>
  write(bytes: Buffer): Promise<void>
  close(): Promise<void>
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error('Windows pipe operation failed', { cause: error })

/** The native owner never exposes a descriptor to JavaScript. */
export class WindowsPipeStream extends Duplex {
  private reading = false
  private closing: Promise<void> | undefined

  constructor(private readonly owner: OwnedPipe) {
    super({ allowHalfOpen: false, highWaterMark: BLOCK_BYTES })
  }

  private closeOwner(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.owner.close())
    return this.closing
  }

  override _read(): void {
    if (this.reading || this.closing || this.destroyed) return
    this.reading = true
    void Promise.resolve()
      .then(() => (this.closing || this.destroyed ? null : this.owner.read()))
      .then((bytes) => {
        this.reading = false
        if (this.closing || this.destroyed) return
        if (bytes !== null && (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BLOCK_BYTES))
          throw new Error('invalid Windows pipe read result')
        this.push(bytes)
      })
      .catch((error: unknown) => {
        this.reading = false
        if (!this.closing && !this.destroyed) this.destroy(asError(error))
      })
  }

  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const send = async () => {
      for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
        if (this.destroyed || this.closing) throw new Error('Windows pipe closed during write')
        await this.owner.write(bytes.subarray(offset, offset + BLOCK_BYTES))
      }
    }
    void send().then(
      () => callback(),
      (error: unknown) => callback(asError(error)),
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.closeOwner().then(
      () => {
        this.push(null)
        callback()
        this.destroy()
      },
      (error: unknown) => callback(asError(error)),
    )
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.closeOwner().then(
      () => callback(error),
      (closeError: unknown) => callback(error ?? asError(closeError)),
    )
  }
}

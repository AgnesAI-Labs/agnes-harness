export type TokenBucketOptions = {
  tokensPerSecond: number
  capacity: number
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
}

/** A FIFO token bucket. Concurrent callers cannot consume the same token. */
export class TokenBucket {
  private readonly tokensPerSecond: number
  private readonly capacity: number
  private readonly now: () => number
  private readonly sleep: (delayMs: number) => Promise<void>
  private tokens: number
  private refilledAt: number
  private tail = Promise.resolve()

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.tokensPerSecond) || options.tokensPerSecond <= 0) {
      throw new RangeError('tokensPerSecond must be greater than zero')
    }
    if (!Number.isFinite(options.capacity) || options.capacity < 1) {
      throw new RangeError('capacity must be at least one')
    }
    this.tokensPerSecond = options.tokensPerSecond
    this.capacity = options.capacity
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    this.tokens = options.capacity
    this.refilledAt = this.now()
  }

  take(signal?: AbortSignal): Promise<void> {
    const turn = this.tail.then(() => this.acquire(signal))
    this.tail = turn.catch(() => undefined)
    return turn
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted()
      const now = this.now()
      const elapsedSeconds = Math.max(0, now - this.refilledAt) / 1_000
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.tokensPerSecond)
      this.refilledAt = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.tokensPerSecond) * 1_000))
      await abortable(this.sleep(waitMs), signal)
    }
  }
}

async function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Split without dropping separators; paragraph and line boundaries are preferred. */
export function chunkText(text: string, max: number): string[] {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('max must be a positive integer')
  if (text.length <= max) return [text]

  const chunks: string[] = []
  let offset = 0
  while (text.length - offset > max) {
    const windowEnd = offset + max
    let cut = text.lastIndexOf('\n\n', windowEnd - 1)
    cut = cut < offset ? -1 : cut + 2
    if (cut <= offset || cut > windowEnd) {
      const newline = text.lastIndexOf('\n', windowEnd - 1)
      cut = newline < offset ? windowEnd : newline + 1
    }
    if (
      cut > offset &&
      cut < text.length &&
      /[\uDC00-\uDFFF]/.test(text[cut] as string) &&
      /[\uD800-\uDBFF]/.test(text[cut - 1] as string)
    ) {
      cut--
    }
    if (cut <= offset) cut = windowEnd
    chunks.push(text.slice(offset, cut))
    offset = cut
  }
  chunks.push(text.slice(offset))
  return chunks
}

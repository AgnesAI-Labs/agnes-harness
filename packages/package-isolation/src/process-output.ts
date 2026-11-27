import type { Readable } from 'node:stream'

/** Drain stderr even when the caller does not request diagnostics. */
export function captureCommandStderr(stream: Readable | null, limit: number): () => string {
  const chunks: Buffer[] = []
  let truncated = false
  if (limit === 0) stream?.resume()
  else
    stream?.on('data', (chunk: Buffer) => {
      if (chunk.length > limit) truncated = true
      if (limit <= 0) return
      chunks.push(chunk.subarray(0, limit))
      limit -= Math.min(limit, chunk.length)
    })
  return () => {
    const output = Buffer.concat(chunks).toString('utf8')
    // Keep complete lines so a caller's redactor does not have to classify a clipped credential.
    return truncated ? output.slice(0, output.lastIndexOf('\n') + 1) : output
  }
}

/** Keep bounded output for explicit diagnostic consumers, out of ordinary error serialization.
 * Output is untrusted command data: consumers must redact it before displaying or persisting it. */
export function withCommandOutput(error: Error, stdout: readonly Buffer[], stderr: string): Error {
  if (Object.isExtensible(error)) {
    const property = (value: string) => ({
      value,
      enumerable: false,
      configurable: true,
    })
    Object.defineProperty(error, 'stdout', property(Buffer.concat(stdout).toString('utf8')))
    if (stderr) Object.defineProperty(error, 'stderr', property(stderr))
  }
  return error
}

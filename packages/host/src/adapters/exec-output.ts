/** Preserve UTF-8 across chunks and apply the existing byte cap separately to stdout/stderr. */
export function createExecOutput(max: number) {
  let truncated = false
  const stream = () => {
    const chunks: Buffer[] = []
    let bytes = 0
    return {
      push(chunk: Buffer) {
        if (bytes >= max) {
          truncated = true
          return
        }
        const room = max - bytes
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room))
          bytes = max
          truncated = true
        } else {
          chunks.push(chunk)
          bytes += chunk.byteLength
        }
      },
      text: () => Buffer.concat(chunks).toString('utf8'),
    }
  }
  const stdout = stream(),
    stderr = stream()
  return {
    stdout: stdout.push,
    stderr: stderr.push,
    result: () => ({ stdout: stdout.text(), stderr: stderr.text(), truncated }),
  }
}

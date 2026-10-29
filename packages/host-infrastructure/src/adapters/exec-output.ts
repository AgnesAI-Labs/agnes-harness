import { commandOutputDecoder } from './command-output.js'

/** Preserve encoding across chunks and apply the byte cap separately to stdout/stderr. */
export function createExecOutput(max: number, codePage?: number) {
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
      text: () => {
        const decoder = commandOutputDecoder(codePage)
        return decoder.write(Buffer.concat(chunks)) + decoder.end()
      },
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

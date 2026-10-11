import { isUtf8 } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'

/**
 * Preserve UTF-8 across chunks and apply the existing byte cap separately to stdout/stderr.
 * `codePage` is the console's, for output that is not UTF-8 (see createOutputDecoder).
 */
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
        const decoder = createOutputDecoder(codePage)
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

// The Windows code pages a console can start in, by the label TextDecoder knows them under. The OEM
// pages of Western and Central European systems (437, 850, 852, ...) have no decoder in Node.
const codePageLabels: Readonly<Record<number, string>> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  20866: 'koi8-r',
  21866: 'koi8-u',
  54936: 'gb18030',
}

export function codePageDecoder(codePage: number | undefined): TextDecoder | undefined {
  if (codePage === undefined) return undefined
  const label =
    codePageLabels[codePage] ?? (codePage >= 1250 && codePage <= 1258 ? `windows-${codePage}` : undefined)
  if (!label) return undefined
  try {
    return new TextDecoder(label)
  } catch {
    return undefined // A Node built without full ICU decodes UTF-8 only.
  }
}

// How much of an unfinished line that is not plain ASCII is held back to learn its encoding.
const HOLD_BYTES = 64 * 1024
const empty = Buffer.alloc(0)

/** How many bytes at the end of `bytes` start a UTF-8 character that the bytes do not finish. */
function unfinished(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back] as number
    if ((byte & 0xc0) === 0x80) continue
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return length > back ? back : 0
  }
  return 0
}

/**
 * A command's output is UTF-8, except what a program writes in the console's code page: Windows
 * PowerShell before its prelude has run (a script that does not parse), and native programs that
 * ignore the console's UTF-8 setting. Each writer writes whole lines, so the encoding is decided per
 * line: UTF-8 when the line is valid UTF-8, else the code page. Without a code page that Node can
 * decode, the output is decoded as UTF-8, as it always was. LF and CR end a line; neither byte
 * occurs inside a character in any of these code pages.
 */
export function createOutputDecoder(codePage?: number): { write(chunk: Buffer): string; end(): string } {
  const fallback = codePageDecoder(codePage)
  if (!fallback) {
    const decoder = new StringDecoder('utf8')
    return { write: (chunk) => decoder.write(chunk), end: () => decoder.end() }
  }
  const decode = (bytes: Buffer): string => {
    if (isUtf8(bytes)) return bytes.toString('utf8')
    let text = ''
    for (let start = 0; start < bytes.length; ) {
      let stop = start
      while (stop < bytes.length && bytes[stop] !== 0x0a && bytes[stop] !== 0x0d) stop++
      const line = bytes.subarray(start, Math.min(stop + 1, bytes.length))
      // A character cut off at the end (a byte cap, a stream that stops) does not make a line code page text.
      text += isUtf8(line.subarray(0, line.length - unfinished(line)))
        ? line.toString('utf8')
        : fallback.decode(line)
      start = stop + 1
    }
    return text
  }
  let held = empty
  return {
    write(chunk) {
      const bytes = held.length ? Buffer.concat([held, chunk]) : chunk
      const lines = Math.max(bytes.lastIndexOf(0x0a), bytes.lastIndexOf(0x0d)) + 1
      const rest = bytes.subarray(lines)
      // An unfinished line goes on at once when it is plain ASCII (a prompt, progress dots): no
      // encoding can change it. Otherwise it is held until it ends, up to a bound; past the bound
      // only a UTF-8 character the chunk cut in two is held.
      let keep = rest.length
      if (rest.every((byte) => byte < 0x80)) keep = 0
      else if (rest.length > HOLD_BYTES) {
        const tail = unfinished(rest)
        keep = tail && isUtf8(rest.subarray(0, rest.length - tail)) ? tail : 0
      }
      held = keep ? Buffer.from(bytes.subarray(bytes.length - keep)) : empty
      return decode(bytes.subarray(0, bytes.length - keep))
    },
    end() {
      const text = held.length ? decode(held) : ''
      held = empty
      return text
    },
  }
}

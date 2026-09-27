const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export type TextPage = Readonly<{ text: string; totalBytes: number; nextOffset?: number }>

/** Offset and cut are UTF-8 byte positions in the body, excluding any repeated header. */
export function pageText(
  body: string,
  offset: number,
  budget: number,
  footerFor: (end: number, total: number) => string,
): TextPage | undefined {
  const bytes = encoder.encode(body)
  const totalBytes = bytes.byteLength
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) return
  if (offset === totalBytes && totalBytes > 0) return
  if (totalBytes === 0) return { text: '', totalBytes }
  if (offset < totalBytes && ((bytes[offset] ?? 0) & 0xc0) === 0x80) return
  if (totalBytes - offset <= budget) return { text: decoder.decode(bytes.subarray(offset)), totalBytes }

  const reserved = encoder.encode(footerFor(totalBytes, totalBytes)).byteLength
  const room = budget - reserved
  let end = Math.min(totalBytes, offset + Math.max(0, room))
  while (end > offset && end < totalBytes && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  if (end > offset) {
    const halfway = offset + Math.floor(Math.max(0, room) / 2)
    for (let i = end - 1; i >= halfway; i--) {
      if (bytes[i] === 0x0a) {
        end = i + 1
        break
      }
    }
  }
  if (end <= offset) {
    const first = bytes[offset] ?? 0
    end = offset + (first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4)
  }
  if (end >= totalBytes) return { text: decoder.decode(bytes.subarray(offset)), totalBytes }
  return {
    text: decoder.decode(bytes.subarray(offset, end)) + footerFor(end, totalBytes),
    totalBytes,
    nextOffset: end,
  }
}

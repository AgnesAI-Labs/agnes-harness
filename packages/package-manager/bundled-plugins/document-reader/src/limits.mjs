export const LIMITS = Object.freeze({
  inputBytes: 100 * 1024 * 1024,
  textBytes: 8 * 1024 * 1024,
  pages: 2000,
  pixels: 8_000_000,
  dimension: 4096,
  imageDimension: 1456,
  imageBytes: 4 * 1024 * 1024,
  timeoutMs: 90_000,
  workers: 2,
})

export function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

export function checkedText(text) {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.textBytes)
    throw fail('DOCUMENT_TEXT_LIMIT', 'Extracted text exceeds 8 MiB.')
  return text.replaceAll('\u0000', '')
}

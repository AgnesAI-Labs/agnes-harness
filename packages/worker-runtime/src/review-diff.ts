import { Buffer } from 'node:buffer'

const MAX_WORK = 200_000,
  MAX_DIFF_BYTES = 64 * 1024
export type ReviewDiff = { added: number; removed: number; diff: string }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** A bounded line diff. Refuse costly comparisons rather than fabricate line counts. */
export function reviewDiff(path: string, before: string, after: string): ReviewDiff | undefined {
  const left = lines(before),
    right = lines(after)
  let prefix = 0,
    suffix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++
  const a = left.slice(prefix, left.length - suffix),
    b = right.slice(prefix, right.length - suffix)
  if ((a.length + 1) * (b.length + 1) > MAX_WORK || left.length + right.length > 16_384) return undefined
  const width = b.length + 1,
    table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + (table[(i + 1) * width + j + 1] ?? 0)
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
  const chunks: string[] = [],
    name = [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ? JSON.stringify(path)
      : path
  let bytes = 0,
    added = 0,
    removed = 0
  const push = (text: string): void => {
    bytes += Buffer.byteLength(text)
    chunks.push(text)
  }
  const line = (mark: string, text: string): void =>
    push(mark + text + (text.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'))
  if (before === after) return { added, removed, diff: '' }
  push(
    `--- a/${name}\n+++ b/${name}\n@@ -${left.length ? 1 : 0},${left.length} +${right.length ? 1 : 0},${right.length} @@\n`,
  )
  for (const value of left.slice(0, prefix)) line(' ', value)
  let i = 0,
    j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      line(' ', a[i++] ?? '')
      j++
    } else if (
      i < a.length &&
      (j === b.length || (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      removed++
      line('-', a[i++] ?? '')
    } else {
      added++
      line('+', b[j++] ?? '')
    }
    if (bytes > MAX_DIFF_BYTES) return undefined
  }
  for (const value of left.slice(left.length - suffix)) line(' ', value)
  return bytes > MAX_DIFF_BYTES ? undefined : { added, removed, diff: chunks.join('') }
}

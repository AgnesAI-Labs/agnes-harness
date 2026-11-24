import type { MemoryFile } from '@agnes/extension-api'
import type { Chunk } from '@agnes/lexical-search'
import { type MemoryView, mapViewSpanToRawLines } from './view.js'

export function chunkView(file: MemoryFile, view: MemoryView): Array<Chunk & { path: string }> {
  const chunks: Array<Chunk & { path: string }> = []
  for (const segment of view.segments) {
    if (segment.raw === undefined || !segment.length) continue
    const first = mapViewSpanToRawLines(file.content, view, segment.view, segment.view + 1)
    if (!first) continue
    const content = view.content.slice(segment.view, segment.view + segment.length)
    // Within this single raw segment, offsets advance together. Count each line break
    // once instead of rescanning the entire file prefix for every paragraph.
    let line = first.lineStart
    let offset = 0
    const lineAt = (position: number) => {
      while (offset < position) {
        if (content[offset] === '\n') line++
        offset++
      }
      return line
    }
    let start = 0
    const emit = (end: number) => {
      while (end > start && /\s/u.test(content.charAt(end - 1))) end--
      while (start < end && /\s/u.test(content.charAt(start))) start++
      while (start < end) {
        let next = Math.min(end, start + 600)
        if (next < end && /[\uD800-\uDBFF]/u.test(content.charAt(next - 1))) next--
        chunks.push({
          path: file.path,
          lineStart: lineAt(start),
          lineEnd: lineAt(next - 1),
          text: content.slice(start, next),
        })
        start = next
      }
    }
    // A heading stands on its own; consecutive nonblank body lines form one paragraph.
    for (const line of content.matchAll(/[^\n]*(?:\n|$)/gu)) {
      const heading = /^[ \t]{0,3}#{1,6}(?:\s|$)/u.test(line[0])
      if (line[0].trim() && !heading) continue
      emit(line.index)
      start = line.index
      if (heading) emit(start + line[0].length)
      start = line.index + line[0].length
    }
    emit(content.length)
  }
  return chunks
}

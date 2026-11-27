import { annotations, expiryTime, markerLines } from '@agnes/protocol/memory-expiry'

type ExpiryLine = { start: number; end: number; expiresAt: number }
export type MemoryEntry = {
  source: string
  start: number
  end: number
  body: number
  preview: string
  expiry: ExpiryLine[]
}

type CommentBody = { visible: string; comment: boolean }

function commentBody(text: string, comment: boolean): CommentBody {
  let visible = ''
  let cursor = 0
  for (const token of text.matchAll(/<!--|-->/gu)) {
    if (!comment && token[0] === '<!--') {
      visible += text.slice(cursor, token.index)
      comment = true
    } else if (comment && token[0] === '-->') {
      cursor = token.index + 3
      comment = false
    }
  }
  if (!comment) visible += text.slice(cursor)
  return { visible: visible.trim(), comment }
}

function markdownColumns(prefix: string) {
  let column = 0
  for (const char of prefix) column += char === '\t' ? 4 - (column % 4) : 1
  return column
}

/** Match provenance's blank-line boundaries, retaining offsets into the exact saved string. */
export function memoryEntries(content: string): MemoryEntry[] {
  const markers = markerLines(content)
  // Match an opener through its closing marker even when a stray marker intervenes.
  // Like the file parser, an unmatched opener extends to the next marker or EOF.
  const regionEnds = new Map<number, number>()
  const nextCloser = new Map<string, number>()
  let nextBoundary = content.length
  for (const marker of markers.reverse()) {
    const close = marker.id ? nextCloser.get(marker.id) : undefined
    regionEnds.set(marker.end, marker.open ? (close ?? nextBoundary) : marker.end)
    if (!marker.open && marker.id) nextCloser.set(marker.id, marker.end)
    nextBoundary = marker.start
  }
  let protectedEnd = 0
  const times = new Map(Array.from(annotations(content), (line) => [line.start, line.expiresAt]))
  const entries: MemoryEntry[] = []
  let entry: MemoryEntry | undefined
  let excluded = false
  let fence: { run: string; quotes: number; listIndent: number } | undefined
  const listIndents: number[] = []
  let listQuotes = 0
  let comment = false
  function finish() {
    if (entry?.preview && !excluded && !fence && !comment) entries.push(entry)
    entry = undefined
    excluded = false
  }
  for (const line of content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const raw = line[0]
    const text = raw.trim()
    const start = line.index + Number(line.index === 0 && content.startsWith('\uFEFF'))
    const end = line.index + raw.length
    const markdown = content.slice(start, end).replace(/\r?\n$/u, '')
    const quotePrefix = /^(?:[ \t]*>[ \t]?)*/u.exec(markdown)![0]
    const quotes = quotePrefix.split('>').length - 1
    const inner = markdown.slice(quotePrefix.length)
    const [prefix, spaces, marker] = /^([ \t]*)((?:[-+*]|\d{1,9}[.)])[ \t]+)?/u.exec(inner)!
    const indent = markdownColumns(spaces!)
    if (
      fence &&
      (quotes < fence.quotes || (quotes === fence.quotes && inner.trim() && indent < fence.listIndent))
    ) {
      if (entry) excluded = true
      fence = undefined
    }
    if (!fence && inner.trim()) {
      if (listQuotes !== quotes) listIndents.length = 0
      listQuotes = quotes
      while (listIndents.length && indent < listIndents.at(-1)!) listIndents.pop()
      if (marker && !comment) listIndents.push(markdownColumns(prefix))
    }
    if (!text) {
      finish()
      continue
    }
    entry ??= { source: content, start, end, body: start, preview: '', expiry: [] }
    entry.end = end
    protectedEnd = Math.max(protectedEnd, regionEnds.get(end) ?? 0)
    if (start < protectedEnd) excluded = true

    // A fence spanning a separator is split across provenance blocks. Neither half is actionable.
    const delimiter = /^(`{3,}|~{3,})(.*)$/u.exec(inner.slice(prefix.length))
    if (fence && entry.start === start) excluded = true
    const inFence = !!fence
    if (delimiter && !comment) {
      const [, run, tail] = delimiter
      if (!fence) {
        fence = { run: run!, quotes, listIndent: listIndents.at(-1) ?? 0 }
      } else if (
        quotes === fence.quotes &&
        !marker &&
        indent <= fence.listIndent + 3 &&
        run!.startsWith(fence.run) &&
        !tail!.trim()
      ) {
        fence = undefined
      }
    }

    // Keep standalone header comments (especially ref:) ahead of the inserted expiry.
    const continuedComment = comment
    const body: CommentBody =
      inFence || fence ? { visible: text, comment: false } : commentBody(text, comment)
    comment = body.comment
    // A split comment or one ending on the first body line cannot safely receive a header.
    if (continuedComment && (entry.start === start || (!entry.preview && body.visible))) excluded = true
    const expiresAt = times.get(line.index)
    if (expiresAt !== undefined) {
      if (entry.preview || continuedComment) excluded = true
      entry.expiry.push({ start, end, expiresAt })
    } else if (!entry.preview && body.visible) {
      entry.preview = body.visible
      entry.body = start
    }
  }
  finish()
  return entries
}

function replaceHeader(content: string, entry: MemoryEntry, annotation: string) {
  if (content !== entry.source) throw new Error('Memory entry has changed')
  let header = ''
  let cursor = entry.start
  for (const line of entry.expiry) {
    header += content.slice(cursor, line.start)
    cursor = line.end
  }
  return (
    content.slice(0, entry.start) +
    header +
    content.slice(cursor, entry.body) +
    annotation +
    content.slice(entry.body)
  )
}

export function setEntryExpiry(content: string, entry: MemoryEntry, isoUtcTimestamp: string) {
  const time = expiryTime(isoUtcTimestamp)
  if (!Number.isFinite(time) || new Date(time).toISOString().replace(/\.\d{3}Z$/u, 'Z') !== isoUtcTimestamp)
    throw new RangeError('Expected a UTC timestamp with whole seconds')
  const newline = content.match(/\r?\n/u)?.[0] ?? '\n'
  return replaceHeader(content, entry, `<!-- expires_at: ${isoUtcTimestamp} -->${newline}`)
}

export function clearEntryExpiry(content: string, entry: MemoryEntry) {
  return replaceHeader(content, entry, '')
}

export function deleteEntry(content: string, entry: MemoryEntry) {
  if (content !== entry.source) throw new Error('Memory entry has changed')
  const before = content.slice(0, entry.start)
  const after = content.slice(entry.end)
  const remaining = after.replace(/^(?:[^\S\n]*\n)+/u, '')
  if (remaining.trim()) return before + remaining
  // At EOF preserve the last surviving line's ending if the file had one.
  const prior = before.replace(/(?:\r?\n[^\S\n]*)+$/u, '')
  const ending =
    prior.trim() && content.endsWith('\n') ? (before.slice(prior.length).match(/^\r?\n/u)?.[0] ?? '') : ''
  return prior + ending
}

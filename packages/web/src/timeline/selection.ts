export function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80
}

export type SavedSelection = {
  text: string
  ranges: Array<{ start: Node; startOffset: number; end: Node; endOffset: number }>
}

export function saveTranscriptSelection(transcript: HTMLElement): SavedSelection | undefined {
  const selection = globalThis.getSelection?.()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
  if (
    !ranges.every(
      (range) => transcript.contains(range.startContainer) && transcript.contains(range.endContainer),
    )
  )
    return undefined
  return {
    text: selection.toString(),
    ranges: ranges.map((range) => ({
      start: range.startContainer,
      startOffset: range.startOffset,
      end: range.endContainer,
      endOffset: range.endOffset,
    })),
  }
}

export function restoreTranscriptSelection(transcript: HTMLElement, saved: SavedSelection | undefined): void {
  const selection = globalThis.getSelection?.()
  if (!saved || !selection || selection.toString() === saved.text) return
  if (!saved.ranges.every((range) => transcript.contains(range.start) && transcript.contains(range.end)))
    return
  try {
    selection.removeAllRanges()
    for (const savedRange of saved.ranges) {
      const range = document.createRange()
      range.setStart(savedRange.start, savedRange.startOffset)
      range.setEnd(savedRange.end, savedRange.endOffset)
      selection.addRange(range)
    }
  } catch {
    // A renderer may have shortened a still-connected text node. In that case the
    // browser's adjusted selection is safer than manufacturing a replacement range.
  }
}

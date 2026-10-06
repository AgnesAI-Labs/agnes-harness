/** Bound the returned page without discarding the middle of long lines. Offsets count wrapped rows. */
export function textPage(result, { offset = 1, limit = 100 }, maxBytes) {
  const budget = Math.min(maxBytes, 32768) - 700
  const rows = []
  let number = 0,
    used = 0,
    next
  let start = 0
  while (start <= result.text.length) {
    const end = result.text.indexOf('\n', start)
    const logical = result.text.slice(start, end === -1 ? undefined : end)
    let line = '',
      size = 0
    const emit = () => {
      number++
      if (number < offset || next) return
      const row = `${number}\t${line}`,
        cost = Buffer.byteLength(row) + 1
      if (rows.length >= limit || used + cost > budget) {
        next = number
        return
      }
      rows.push(row)
      used += cost
    }
    for (const character of logical) {
      const cost = Buffer.byteLength(character)
      if (size + cost > 2048) {
        emit()
        if (next) break
        line = ''
        size = 0
      }
      line += character
      size += cost
    }
    if (!next) emit()
    if (next || end === -1) break
    start = end + 1
  }
  return `[${result.format}] ${result.note}\n${rows.join('\n')}${next ? `\n[Call document_read again with offset=${next}; keep the same path, entry, page, mode and OCR options.]` : number < offset ? '\n[No rows at this offset.]' : ''}`
}

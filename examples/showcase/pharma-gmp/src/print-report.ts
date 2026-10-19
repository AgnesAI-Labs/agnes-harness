/** Render only the headings, lists and tables authored by this package; never accept raw HTML. */
export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
export function printReport(lines: string[]) {
  const blocks: string[] = []
  let list = false
  const closeList = () => {
    if (list) blocks.push('</ul>')
    list = false
  }
  const cells = (line: string) =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => escapeHtml(cell.trim()))
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line) {
      closeList()
      continue
    }
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[-:| ]+\|$/)) {
      closeList()
      blocks.push(
        `<table><thead><tr>${cells(line)
          .map((cell) => `<th scope="col">${cell}</th>`)
          .join('')}</tr></thead><tbody>`,
      )
      i++
      while (lines[i + 1]?.startsWith('|'))
        blocks.push(
          `<tr>${cells(lines[++i] ?? '')
            .map((cell) => `<td>${cell}</td>`)
            .join('')}</tr>`,
        )
      blocks.push('</tbody></table>')
    } else if (/^#{2,3} /.test(line)) {
      closeList()
      const level = line.startsWith('### ') ? 3 : 2
      blocks.push(`<h${level}>${escapeHtml(line.slice(level + 1))}</h${level}>`)
    } else if (line.startsWith('- ')) {
      if (!list) {
        blocks.push('<ul>')
        list = true
      }
      blocks.push(
        `<li>${escapeHtml(line.slice(2))
          .replace(/^\[x\]/, '✓')
          .replace(/^\[ \]/, '○')}</li>`,
      )
    } else {
      closeList()
      blocks.push(`<p>${escapeHtml(line)}</p>`)
    }
  }
  closeList()
  return blocks.join('\n')
}

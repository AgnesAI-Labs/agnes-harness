export function countLines(text: string): number {
  let n = 0
  let inBlock = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      inBlock = false
      const rest = line.slice(end + 2).trim()
      if (rest === '' || rest.startsWith('//')) continue
      if (rest.startsWith('/*')) {
        if (!rest.includes('*/')) inBlock = true
        continue
      }
      n++
      continue
    }
    if (line === '' || line.startsWith('//')) continue
    const start = line.indexOf('/*')
    if (start === -1) {
      n++
      continue
    }
    // A /* appearing mid-line, not necessarily at the start (e.g. `const a = 1 /* start`): if there is
    // real code before the /*, this line still counts as a code line. If there is no matching */ later
    // on the same line, block-comment state must be entered, or the pure-comment continuation lines
    // that follow would be miscounted as code lines.
    const before = line.slice(0, start).trim()
    if (before !== '') n++
    if (!line.includes('*/', start)) inBlock = true
  }
  return n
}

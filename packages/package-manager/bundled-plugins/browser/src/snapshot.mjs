const fields = [
  'name',
  'text',
  'url',
  'placeholder',
  'checked',
  'disabled',
  'expanded',
  'selected',
  'pressed',
  'active',
  'invalid',
  'level',
]

function lineFor(row, query, ref) {
  const values = {}
  let truncated = row.depth > 20
  for (const key of fields) {
    const value = row.node[key]
    if (typeof value === 'string') {
      const at = query ? value.toLowerCase().indexOf(query) : -1
      const start = Math.max(0, at - 32)
      let length = 1000
      while (JSON.stringify(value.slice(start, start + length)).length > 1800) length = Math.floor(length / 2)
      values[key] = value.slice(start, start + length)
      if (start || value.length > length) {
        values[key] = (start ? '…' : '') + values[key] + (value.length > start + length ? '…' : '')
        truncated = true
      }
    } else if (typeof value === 'boolean' || typeof value === 'number') values[key] = value
  }
  // Escape page content so labels cannot forge hierarchy/ref lines.
  return {
    text:
      '  '.repeat(Math.min(row.depth, 20)) +
      '- ' +
      JSON.stringify({
        role: row.node.role,
        ...values,
        ...(ref ? { ref } : {}),
        ...(row.depth > 20 ? { depth: row.depth } : {}),
      }),
    truncated,
  }
}

export function snapshotRows(tree, input) {
  const rows = [],
    stack = [...tree].reverse().map((node) => ({ node, depth: 0 }))
  // Bound plugin-side processing even for pathological documents. The native
  // snapshot has its own timeout/cancellation; no second DOM walker is injected.
  while (stack.length && rows.length < 50_000) {
    const row = stack.pop()
    if (!row.node || typeof row.node !== 'object') continue
    row.index = rows.length
    rows.push(row)
    const children = row.node.children
    if (Array.isArray(children))
      for (let i = children.length - 1; i >= 0; i--)
        stack.push({ node: children[i], depth: row.depth + 1, parent: row })
  }
  const query = input.query?.toLowerCase()
  const candidates = rows.filter(
    (row) =>
      (input.depth === undefined || row.depth <= input.depth) &&
      (query === undefined ||
        ['role', 'name', 'text', 'url', 'placeholder'].some(
          (key) => typeof row.node[key] === 'string' && row.node[key].toLowerCase().includes(query),
        )),
  )
  const offset = input.cursor ?? 0,
    window = [],
    included = new Set()
  let size = 0
  for (const row of candidates.slice(offset, offset + (input.ref ? 99 : 100))) {
    const added = []
    for (let current = row; current && !included.has(current); current = current.parent) added.push(current)
    const cost = added.reduce(
      (total, current) =>
        total + lineFor(current, query, current.node.ref ? '0'.repeat(36) : undefined).text.length + 1,
      0,
    )
    if (window.length && size + cost > 20_000) break
    window.push(row)
    for (const current of added) included.add(current)
    size += cost
  }
  return {
    rows,
    window,
    included,
    query,
    cursor: offset + window.length,
    hasMore: candidates.length > offset + window.length,
    matchCount: candidates.length,
    depthLimited: input.depth !== undefined && rows.some((row) => row.depth > input.depth),
    scanLimited: stack.length > 0,
  }
}

export function snapshotText(snapshot) {
  const lines = []
  let size = 0,
    truncated = false
  for (const row of [...snapshot.included].sort((a, b) => a.index - b.index)) {
    const line = lineFor(row, snapshot.query, row.ref)
    if (size + line.text.length + 1 > 20_000) {
      truncated = true
      break
    }
    lines.push(line.text)
    size += line.text.length + 1
    truncated ||= line.truncated
  }
  return { text: lines.join('\n'), truncated }
}

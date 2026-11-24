/** Each channel contributes at most once per hit; ranks are one-based. */
export function fuse<T>(channels: readonly (readonly T[])[], key: (item: T) => string | number) {
  const hits = new Map<string | number, { item: T; score: number }>()
  for (const channel of channels) {
    const seen = new Set<string | number>()
    for (const [i, item] of channel.entries()) {
      const id = key(item)
      if (seen.has(id)) continue
      seen.add(id)
      const hit = hits.get(id) ?? { item, score: 0 }
      hit.score += 1 / (61 + i)
      hits.set(id, hit)
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score)
}

/** On an already ranked list, keep the highest-scoring chunk of each document. */
export function bestPerDoc<T>(ranked: readonly T[], doc: (item: T) => string): T[] {
  const seen = new Set<string>()
  return ranked.filter((item) => {
    const key = doc(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function fitHits<T extends { text: string }>(ranked: readonly T[], limit: number, maxBytes: number) {
  const hits: T[] = []
  let remaining = maxBytes
  for (const hit of ranked.slice(0, limit)) {
    const size = Buffer.byteLength(hit.text)
    if (size > remaining) {
      let text = ''
      for (const char of hit.text) {
        const bytes = Buffer.byteLength(char)
        if (bytes > remaining) break
        text += char
        remaining -= bytes
      }
      if (text) hits.push({ ...hit, text })
      return { hits, truncated: true }
    }
    hits.push(hit)
    remaining -= size
  }
  return { hits, truncated: hits.length < ranked.length }
}

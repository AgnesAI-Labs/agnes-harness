/**
 * Identifies the extraction rule below. Anything that changes what `extractArtifactRefs` returns
 * for some row must bump it: every persisted reference index built under another value is dropped
 * and rebuilt, because its cursors vouch for prefixes extracted under the old rule.
 */
export const ARTIFACT_REF_EXTRACTOR_VERSION = '2'

const URI = /^artifact:\/\/([0-9a-f]{64})$/u
const SHA256 = /^[0-9a-f]{64}$/u

export function collectLedgerDigests(value: unknown, found: Set<string>, depth = 0): void {
  if (depth > 32) throw new Error('artifact GC ledger row exceeds the safe traversal depth')
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    const match = URI.exec(value)
    if (match?.[1]) found.add(match[1])
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) collectLedgerDigests(child, found, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sha256' && typeof child === 'string' && SHA256.test(child)) found.add(child)
    collectLedgerDigests(child, found, depth + 1)
  }
}

function collectRequestMediaDigests(data: unknown, found: Set<string>): void {
  const manifest = (data as { media?: { manifest?: unknown } } | null)?.media?.manifest
  if (manifest === undefined) return
  if (!Array.isArray(manifest)) throw new Error('artifact GC request-media manifest is malformed')
  for (const entry of manifest) {
    const value = entry as { sha256?: unknown; artifactUri?: unknown } | null
    if (
      !value ||
      typeof value.sha256 !== 'string' ||
      !SHA256.test(value.sha256) ||
      value.artifactUri !== `artifact://${value.sha256}`
    )
      throw new Error('artifact GC request-media manifest identity is malformed')
    found.add(value.sha256)
  }
}

/** Screenshot image links under the same admission rule the daemon's read authority projects. */
function collectToolImageDigests(row: LedgerRefRow, data: unknown, found: Set<string>): void {
  if (row.type !== 'tool/result' || row.origin !== 'tool:computer_use' || row.trust !== 'untrusted') return
  const value = data as { content?: unknown; isError?: unknown } | null
  if (value?.isError !== false || !Array.isArray(value.content)) return
  for (const block of value.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const link = block as Record<string, unknown>
    if (link.type !== 'resource_link' || (link.mimeType !== 'image/png' && link.mimeType !== 'image/jpeg'))
      continue
    const match = typeof link.uri === 'string' ? URI.exec(link.uri) : null
    if (match?.[1]) found.add(match[1])
  }
}

export type LedgerRefRow = Readonly<{
  type: string
  data: string
  origin?: string
  trust?: string
  lane?: string
}>

export type LedgerRowRefs = Readonly<{
  ledger: ReadonlySet<string>
  requestMedia: ReadonlySet<string>
  toolImage: ReadonlySet<string>
  attachments: ReadonlySet<string>
  turn?: Readonly<{ kind: 'start' | 'end'; lane: string }>
}>

/** Stored originals and their thumbnails may never be evicted by screenshot capacity policy. */
function attachmentDigests(row: LedgerRefRow, data: unknown): ReadonlySet<string> {
  const found = new Set<string>()
  if (row.type !== 'user/message' && row.type !== 'inbox') return found
  const value = data as { content?: unknown; items?: { content?: unknown }[] } | null
  const blocks =
    row.type === 'inbox'
      ? Array.isArray(value?.items)
        ? value.items.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        : []
      : Array.isArray(value?.content)
        ? value.content
        : []
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || !('attachment' in block)) continue
    const link = block as {
      type?: unknown
      uri?: unknown
      mimeType?: unknown
      attachment?: { artifact?: unknown; thumbnail?: unknown }
    }
    const artifact = link.attachment?.artifact as
      | { sha256?: unknown; size?: unknown; mime?: unknown }
      | undefined
    if (
      link.type !== 'resource_link' ||
      !artifact ||
      link.uri !== `artifact://${artifact.sha256}` ||
      link.mimeType !== artifact.mime
    )
      throw new Error('artifact GC attachment metadata is malformed')
    for (const value of [artifact, link.attachment?.thumbnail]) {
      if (value === undefined) continue
      const ref = value as { sha256?: unknown; size?: unknown; mime?: unknown }
      if (
        typeof ref.sha256 !== 'string' ||
        !SHA256.test(ref.sha256) ||
        !Number.isSafeInteger(ref.size) ||
        (ref.size as number) < 0 ||
        typeof ref.mime !== 'string'
      )
        throw new Error('artifact GC attachment reference is malformed')
      found.add(ref.sha256)
    }
  }
  return found
}

/**
 * The single extraction rule shared by the reference index and every full-ledger reader, so both
 * see exactly the same references per row. Malformed rows throw and block collection.
 */
export function extractArtifactRefs(row: LedgerRefRow): LedgerRowRefs {
  const data = JSON.parse(row.data) as unknown
  const ledger = new Set<string>()
  const requestMedia = new Set<string>()
  const toolImage = new Set<string>()
  collectLedgerDigests(data, ledger)
  if (row.type === 'request/header') collectRequestMediaDigests(data, requestMedia)
  collectToolImageDigests(row, data, toolImage)
  const turn =
    (row.type === 'turn/start' || row.type === 'turn/end') && row.lane !== undefined
      ? { kind: row.type === 'turn/start' ? ('start' as const) : ('end' as const), lane: row.lane }
      : undefined
  return {
    ledger,
    requestMedia,
    toolImage,
    attachments: attachmentDigests(row, data),
    ...(turn ? { turn } : {}),
  }
}

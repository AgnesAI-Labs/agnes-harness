/**
 * Identifies the extraction rule below. Anything that changes what `extractArtifactRefs` returns
 * for some row must bump it: every persisted reference index built under another value is dropped
 * and rebuilt, because its cursors vouch for prefixes extracted under the old rule.
 */
export const ARTIFACT_REF_EXTRACTOR_VERSION = '1'

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
  turn?: Readonly<{ kind: 'start' | 'end'; lane: string }>
}>

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
  return { ledger, requestMedia, toolImage, ...(turn ? { turn } : {}) }
}

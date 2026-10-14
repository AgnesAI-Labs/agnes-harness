import type { UiArtifactFileData } from '@agnes/protocol/gen/intelligent-ui'

/** What a file is, in the words a reader uses: it picks the tile's icon and colour. */
export type DeliverableType = 'markdown' | 'html' | 'pdf' | 'sheet' | 'image' | 'code' | 'text' | 'file'

const BY_EXTENSION: Record<string, DeliverableType> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  csv: 'sheet',
  tsv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  json: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  sh: 'code',
  yaml: 'code',
  yml: 'code',
  txt: 'text',
  log: 'text',
}

export function deliverableType(name: string, mime: string): DeliverableType {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() : undefined
  const known = extension ? BY_EXTENSION[extension] : undefined
  if (known) return known
  if (mime === 'text/markdown') return 'markdown'
  if (mime === 'text/html') return 'html'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/csv') return 'sheet'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/json') return 'code'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

/**
 * The version a description names, without the package that wrote it: "crm-assistant: final"
 * reads as the final version. Words other than the two shared ones are shown as written.
 */
export function deliverableVersion(
  description: string,
): { key: 'ui.file.final' | 'ui.file.reviewDraft' } | { text: string } | undefined {
  const text = description.replace(/^[^\s:]+:\s+/, '').trim()
  if (!text) return undefined
  const word = text.toLowerCase()
  if (word === 'final') return { key: 'ui.file.final' }
  if (word === 'review draft' || word === 'draft') return { key: 'ui.file.reviewDraft' }
  return { text }
}

export type TurnDeliverable = {
  file: UiArtifactFileData
  surfaceId: string
  /** The component that lists it: one surface may list the same bytes under two names, or twice. */
  componentId?: string
  revision: number
  lane: string
  /** Workbench copy exists, so a preview opens there. */
  workbench: boolean
  /** Order of appearance in the session; a later entry is a newer version. */
  order: number
  /** When it was presented (epoch ms), when the surface records it. */
  presentedAt?: number
}

/** How an earlier version differs from the file's latest one, for its card and preview. */
export type EarlierVersion = {
  /** When it was presented (epoch ms); absent for surfaces that predate the record. */
  presentedAt?: number
  /** 1 for the first version of the name. */
  ordinal: number
  /** This version's size minus the latest one's, in bytes. */
  sizeDelta: number
  /** Its description says the same as the latest one's, so the card leaves it out. */
  sameDescription: boolean
}

const sameContent = (a: TurnDeliverable, b: TurnDeliverable) =>
  a.file.name === b.file.name && a.file.artifact.sha256 === b.file.artifact.sha256

/** How `earlier` differs from `latest`; `ordinal` is its place in the name's history, oldest first. */
export function earlierVersion(
  earlier: TurnDeliverable,
  latest: TurnDeliverable,
  ordinal: number,
): EarlierVersion {
  return {
    ...(earlier.presentedAt === undefined ? {} : { presentedAt: earlier.presentedAt }),
    ordinal,
    sizeDelta: earlier.file.artifact.size - latest.file.artifact.size,
    sameDescription: earlier.file.description.trim() === latest.file.description.trim(),
  }
}

/**
 * One entry per file name, newest first in each name's history. The list keeps the order in which
 * names first appeared, so a new version does not move its file around the group. Presenting the
 * same bytes again is not a new version: only the newest presentation of each content is kept.
 */
export function groupDeliverables(
  entries: readonly TurnDeliverable[],
): { latest: TurnDeliverable; earlier: (TurnDeliverable & { version: EarlierVersion })[] }[] {
  const byName = new Map<string, TurnDeliverable[]>()
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const list = byName.get(entry.file.name)
    if (list) list.push(entry)
    else byName.set(entry.file.name, [entry])
  }
  return [...byName.values()].map((presented) => {
    // Keep the newest presentation of each content, in the order the contents first appeared.
    const versions = presented.filter(
      (entry, index) => !presented.slice(index + 1).some((later) => sameContent(entry, later)),
    )
    const latest = versions.at(-1)!
    const earlier = versions
      .slice(0, -1)
      .map((entry, index) => ({ ...entry, version: earlierVersion(entry, latest, index + 1) }))
      .reverse()
    return { latest, earlier }
  })
}

/**
 * Every deliverable file of the session, keyed by surface and file: `hidden` for a repeat of newer
 * identical content, an `EarlierVersion` for an older version of its name. The workbench reads it
 * to show the same versions the conversation does.
 */
export function deliverableVersions(
  entries: readonly TurnDeliverable[],
): Map<string, 'hidden' | EarlierVersion> {
  const out = new Map<string, 'hidden' | EarlierVersion>()
  const shown = new Set<TurnDeliverable>()
  for (const { latest, earlier } of groupDeliverables(entries)) {
    shown.add(latest)
    for (const entry of earlier) {
      out.set(deliverableKey(entry), entry.version)
      shown.add(entries.find((item) => deliverableKey(item) === deliverableKey(entry))!)
    }
  }
  for (const entry of entries) if (!shown.has(entry)) out.set(deliverableKey(entry), 'hidden')
  return out
}
/**
 * A presented file's identity: its surface, the component listing it, its name and its content.
 * The hash alone names content, not a row — two names for the same bytes are two deliverables.
 */
export const deliverableKey = (entry: Pick<TurnDeliverable, 'surfaceId' | 'componentId' | 'file'>) =>
  `${entry.surfaceId}:${entry.componentId ?? ''}:${entry.file.name}:${entry.file.artifact.sha256}`

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
  revision: number
  lane: string
  /** Workbench copy exists, so a preview opens there. */
  workbench: boolean
  /** Order of appearance in the session; a later entry is a newer version. */
  order: number
}

/**
 * One entry per file name, newest first in each name's history. The list keeps the order in which
 * names first appeared, so a new version does not move its file around the group.
 */
export function groupDeliverables(
  entries: readonly TurnDeliverable[],
): { latest: TurnDeliverable; earlier: TurnDeliverable[] }[] {
  const byName = new Map<string, TurnDeliverable[]>()
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const list = byName.get(entry.file.name)
    if (list) list.push(entry)
    else byName.set(entry.file.name, [entry])
  }
  return [...byName.values()].map((versions) => {
    const newest = [...versions].reverse()
    return { latest: newest[0]!, earlier: newest.slice(1) }
  })
}

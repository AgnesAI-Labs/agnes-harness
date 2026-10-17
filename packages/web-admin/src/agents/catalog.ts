import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import type { PluginAdminApi } from '../admin/plugins/api.js'

type Locale = 'en' | 'zh-CN'

export type BusinessAgent = {
  entry: PackageCatalogDescriptor
  /** Last path segment of the package id: `data-report`. */
  slug: string
  name: string
  summary: string | undefined
  /** Present only when the package carries one; the card then shows a "try" line. */
  samplePrompt: string | undefined
  /** One or two characters for the letter tile, and a stable tint out of eight. */
  glyph: string
  tint: number
}
export type BusinessAgentState = 'available' | 'installed' | 'starting' | 'ready' | 'attention'

const TINTS = 8

/** Catalogue availability comes from explicit launch declarations, independently of package names. */
export function isBusinessAgent(row: PackageCatalogDescriptor): boolean {
  return Object.keys(row.agents ?? {}).length > 0 && !row.metadata?.exampleOf
}

export function samplePromptOf(row: PackageCatalogDescriptor, locale: Locale): string | undefined {
  return resolvePluginMetadata(row.metadata, locale)?.samplePrompt?.trim() || undefined
}

const hash = (text: string) => {
  let value = 0
  for (let index = 0; index < text.length; index++)
    value = (Math.imul(value, 31) + text.charCodeAt(index)) | 0
  return Math.abs(value)
}

/** Latin names abbreviate to initials; a CJK name leads with its first character. */
function glyphOf(name: string, slug: string): string {
  const first = [...name.trim()][0]
  if (first && first.charCodeAt(0) > 0x2e7f) return first
  const words = (name.trim() || slug).split(/[\s\-_/]+/).filter(Boolean)
  return (
    words
      .slice(0, 2)
      .map((word) => [...word][0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

export function businessAgentView(entry: PackageCatalogDescriptor, locale: Locale): BusinessAgent {
  const slug = entry.id.split('/').at(-1) ?? entry.id
  const metadata = resolvePluginMetadata(entry.metadata, locale)
  const name = metadata?.displayName ?? slug
  return {
    entry,
    slug,
    name,
    summary: metadata?.summary,
    samplePrompt: samplePromptOf(entry, locale),
    glyph: glyphOf(name, slug),
    tint: hash(entry.id) % TINTS,
  }
}

/** Ready means the package is enabled and its plugin is actually running. */
export function businessAgentState(
  installed: PackageInstalledDescriptor | undefined,
  starting = false,
): BusinessAgentState {
  if (starting) return 'starting'
  if (!installed) return 'available'
  if (installed.desired === 'enabled' && installed.actual === 'running') return 'ready'
  if (installed.actual === 'failed' || installed.actual === 'restart-required' || installed.blockers.length)
    return 'attention'
  return 'installed'
}

/** Reads the whole catalog once; the daemon pages it and the gallery shows business agents only. */
export async function readBusinessAgents(
  api: Pick<PluginAdminApi, 'catalog'>,
  signal?: AbortSignal,
): Promise<PackageCatalogDescriptor[]> {
  const result = new Map<string, PackageCatalogDescriptor>()
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    const page = await api.catalog(undefined, cursor)
    for (const row of page.items) if (isBusinessAgent(row) && !result.has(row.id)) result.set(row.id, row)
    cursor = page.nextCursor ?? undefined
  } while (cursor && !signal?.aborted && result.size < 256 && pages < 32)
  return [...result.values()]
}

/** Ready agents lead; the rest keep catalog order. The new-session empty state takes the first three. */
export function suggestedBusinessAgents<T extends { entry: PackageCatalogDescriptor }>(
  agents: readonly T[],
  installed: readonly PackageInstalledDescriptor[],
  count = 3,
): T[] {
  const ready = (agent: T) =>
    businessAgentState(installed.find((item) => item.id === agent.entry.id)) === 'ready' ? 0 : 1
  return [...agents].sort((a, b) => ready(a) - ready(b)).slice(0, count)
}

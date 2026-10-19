import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { resolvePluginMetadata } from '@agnes/protocol'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { exampleDiscovery } from './discovery.js'

type Locale = 'en' | 'zh-CN'

export type BusinessAgent = {
  ref: string
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
  return (row.agents?.length ?? 0) > 0
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
  const declared = entry.agents?.length === 1 ? entry.agents[0] : undefined
  if (!declared) throw new Error('An explicit agent selection is required')
  const launch = declared.launch
  const ref = declared.ref
  const packageSlug = entry.id.split('/').at(-1) ?? entry.id
  const bundleSlug = ref.split('#')[1] ?? ''
  const slug = packageSlug === bundleSlug ? packageSlug : `${packageSlug}-${bundleSlug}`
  const name = launch.title[locale] ?? launch.title.en
  return {
    ref,
    entry,
    slug,
    name,
    summary: launch.description[locale] ?? launch.description.en,
    samplePrompt: launch.prompt?.text[locale] ?? launch.prompt?.text.en,
    glyph: glyphOf(name, slug),
    tint: hash(ref) % TINTS,
  }
}

/** Display the backend readiness projection; launch admission still runs on explicit start. */
export function businessAgentState(
  installed: PackageInstalledDescriptor | undefined,
  starting = false,
): BusinessAgentState {
  if (starting) return 'starting'
  if (!installed) return 'available'
  if (installed.primaryStatus)
    return installed.primaryStatus.state === 'ready'
      ? 'ready'
      : ['blocked', 'restart-required'].includes(installed.primaryStatus.state)
        ? 'attention'
        : 'installed'
  if (
    installed.trusted &&
    installed.desired === 'enabled' &&
    installed.actual === 'running' &&
    !installed.blockers.length
  )
    return 'ready'
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
  return [...result.values()].flatMap((entry) =>
    (entry.agents ?? []).map((agent) => ({ ...entry, agents: [agent] })),
  )
}

/** Ready agents lead; the rest keep catalog order. The new-session empty state takes the first three. */
export function suggestedBusinessAgents<T extends { entry: PackageCatalogDescriptor }>(
  agents: readonly T[],
  installed: readonly PackageInstalledDescriptor[],
  count = 3,
): T[] {
  const ready = (agent: T) =>
    businessAgentState(installed.find((item) => item.id === agent.entry.id)) === 'ready' ? 0 : 1
  return agents
    .filter((agent) => exampleDiscovery(agent.entry).featured)
    .sort((a, b) => ready(a) - ready(b))
    .slice(0, count)
}

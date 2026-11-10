import { type PackageCatalogPage, validatePackageAdminData } from '@agnes/protocol'

/** Listing permits discovery only; it does not identify a publisher as official or authorize installation. */
export const COMMUNITY_INDEX_URL = 'https://agnesai-labs.github.io/agh-plugin-market/index.json'
type Item = NonNullable<PackageCatalogPage['community']>['items'][number]

function githubRepository(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid repository URL')
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/?$/i.exec(value)
  if (!match) throw new Error('invalid repository URL')
  const name = (match[2] ?? '').replace(/\.git$/i, '')
  if (!name || name === '.' || name === '..') throw new Error('invalid repository name')
  return `${match[1]}/${name}`.toLowerCase()
}

function localized(value: unknown): Item['summary'] {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid text')
  if (Object.values(value).some((text) => typeof text !== 'string')) throw new Error('invalid text')
  return value as Record<string, string>
}

/** Project the complete format-1 index, without topic searches or entry-count truncation. */
export function indexedCommunityPlugins(value: unknown): Item[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid index')
  const index = value as Record<string, unknown>
  if (index.format !== 1 || !Array.isArray(index.plugins)) throw new Error('invalid index')
  const names = new Set<string>()
  const items = index.plugins.map((entry): Item => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid entry')
    const row = entry as Record<string, unknown>
    const repository = row.repository as Record<string, unknown> | undefined
    if (typeof row.name !== 'string' || !row.name || row.name.length > 214 || names.has(row.name))
      throw new Error('invalid package name')
    names.add(row.name)
    const fullName = githubRepository(repository?.url)
    if (!Array.isArray(row.versions) || !row.versions.length) throw new Error('invalid versions')
    const versions = new Set<string>()
    const sources = row.versions.map((version) => {
      if (!version || typeof version !== 'object' || Array.isArray(version))
        throw new Error('invalid version')
      const record = version as Record<string, unknown>
      const source = record.source as Record<string, unknown> | undefined
      if (
        typeof record.version !== 'string' ||
        !record.version ||
        record.version.length > 128 ||
        versions.has(record.version) ||
        source?.type !== 'git' ||
        githubRepository(source.url) !== fullName ||
        typeof source.commit !== 'string' ||
        !/^[a-f0-9]{40}$/i.test(source.commit)
      )
        throw new Error('invalid source')
      versions.add(record.version)
      return {
        version: record.version,
        source: {
          type: 'git' as const,
          ref: `git:https://github.com/${fullName}.git#${source.commit.toLowerCase()}`,
        },
      }
    })
    const summary = localized(row.description)
    const title = localized(row.title)
    if (row.author !== undefined && typeof row.author !== 'string') throw new Error('invalid author')
    return {
      id: row.name,
      name: row.name,
      fullName,
      description:
        typeof summary === 'string' ? summary : (summary?.en ?? Object.values(summary ?? {})[0] ?? ''),
      ...(summary === undefined ? {} : { summary }),
      ...(title === undefined ? {} : { title }),
      author: (row.author as string | undefined) ?? fullName.split('/')[0]!,
      versions: sources,
    }
  })
  if (
    !validatePackageAdminData('PackageCatalogPage', {
      items: [],
      nextCursor: null,
      community: {
        state: 'ready',
        lastSuccessAt: null,
        nextAttemptAt: null,
        error: null,
        totalReported: items.length,
        items,
      },
    }).ok
  )
    throw new Error('invalid index projection')
  return items
}

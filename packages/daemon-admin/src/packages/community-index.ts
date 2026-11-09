/** Listing permits discovery only; it does not identify a plugin as official or authorize installation. */
export const COMMUNITY_INDEX_URL = 'https://agnesai-labs.github.io/agh-plugin-market/index.json'

function githubRepository(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid repository URL')
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/?$/i.exec(value)
  if (!match) throw new Error('invalid repository URL')
  const name = (match[2] ?? '').replace(/\.git$/i, '')
  if (!name || name === '.' || name === '..') throw new Error('invalid repository name')
  return `${match[1]}/${name}`.toLowerCase()
}

/** Bounded format-1 discovery projection. Every entry must identify one unambiguous GitHub repository. */
export function listedCommunityRepositories(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid index')
  const index = value as Record<string, unknown>
  if (index.format !== 1 || !Array.isArray(index.plugins) || index.plugins.length > 1000)
    throw new Error('invalid index')
  const repositories = new Set<string>()
  for (const entry of index.plugins) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid entry')
    const row = entry as Record<string, unknown>
    const repository = row.repository as Record<string, unknown> | undefined
    if (typeof row.name !== 'string' || !row.name || row.name.length > 214)
      throw new Error('invalid package name')
    const name = githubRepository(repository?.url)
    if (!Array.isArray(row.versions) || !row.versions.length || row.versions.length > 1000)
      throw new Error('invalid versions')
    for (const version of row.versions) {
      if (!version || typeof version !== 'object' || Array.isArray(version))
        throw new Error('invalid version')
      const source = (version as Record<string, unknown>).source as Record<string, unknown> | undefined
      if (
        source?.type !== 'git' ||
        githubRepository(source.url) !== name ||
        typeof source.commit !== 'string' ||
        !/^[a-f0-9]{40}$/i.test(source.commit)
      )
        throw new Error('invalid source')
    }
    repositories.add(name)
  }
  return repositories
}

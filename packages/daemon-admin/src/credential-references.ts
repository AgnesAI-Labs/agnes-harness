import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateAgainst } from '@agnes/protocol'
import { AdminCredentialReference } from '@agnes/protocol/gen/app-server'

/** Values stay inside the backend; only the containing configuration's identity is projected. */
export type CredentialConfiguration = AdminCredentialReference & { value: unknown }

export function referencesIn(configurations: readonly CredentialConfiguration[]) {
  const refs = new Map<string, AdminCredentialReference[]>()
  const walk = (value: unknown, found: Set<string>): void => {
    if (typeof value === 'string' && /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(value)) found.add(value)
    else if (value && typeof value === 'object') for (const child of Object.values(value)) walk(child, found)
  }
  for (const { value, ...identity } of configurations) {
    if (!validateAgainst(AdminCredentialReference, identity).ok)
      throw new Error('invalid configuration identity')
    const found = new Set<string>()
    walk(value, found)
    for (const ref of found) {
      const items = refs.get(ref) ?? []
      if (!items.some((item) => JSON.stringify(item) === JSON.stringify(identity))) items.push(identity)
      if (items.length > 4096) throw new Error('credential reference capacity')
      refs.set(ref, items)
    }
  }
  return refs
}

async function entries(path: string) {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe configuration directory')
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function json(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new Error('unsafe configuration file')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

/** Include other saved profiles and disabled MCP definitions, since credentials belong to the home. */
export async function savedCredentialConfigurations(
  home: string,
  dataDir: string,
): Promise<CredentialConfiguration[]> {
  const values: CredentialConfiguration[] = []
  for (const profile of await entries(join(home, 'profiles'))) {
    if (profile.isSymbolicLink()) throw new Error('unsafe profile')
    if (!profile.isDirectory()) continue
    for (const file of await entries(join(home, 'profiles', profile.name))) {
      if (!file.name.endsWith('.json')) continue
      values.push({
        kind: 'profile',
        profile: profile.name,
        configId: file.name,
        value: await json(join(home, 'profiles', profile.name, file.name)),
      })
    }
  }
  for (const file of await entries(join(dataDir, 'resource-control', 'mcp'))) {
    if (!file.name.endsWith('.mcp.json')) continue
    const profile = file.name.slice(0, -9)
    const journal = (await json(join(dataDir, 'resource-control', 'mcp', file.name))) as {
      servers?: Record<string, unknown>
      operations?: { operation: { state: string }; params: unknown }[]
    }
    if (!journal.servers || !Array.isArray(journal.operations)) throw new Error('invalid MCP journal')
    for (const [configId, value] of Object.entries(journal.servers))
      values.push({ kind: 'mcp', profile, configId, value })
    for (const operation of journal.operations) {
      if (!['succeeded', 'failed', 'cancelled'].includes(operation.operation.state))
        values.push({ kind: 'mcp', profile, configId: 'pending-operation', value: operation.params })
    }
  }
  return values
}

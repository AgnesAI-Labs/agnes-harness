const LEGACY = 'session_profiles'
const REFUSAL =
  'E_SESSION_TREE_SCHEMA: session_profiles is no longer readable; delete it and create session_trees'

function isLegacyName(value: string): boolean {
  const stem = value.replace(/\.(db|sqlite|sqlite3)$/i, '')
  return value === LEGACY || value.startsWith(`${LEGACY}.`) || stem === LEGACY
}

/** Development-period schema: old session_profiles DBs are refused, never backfilled. */
export function assertSessionTreeStorePath(path: string): void {
  if (path.split(/[/\\]/).some((part) => isLegacyName(part))) throw new Error(REFUSAL)
}

export function assertSessionTreeTableName(name: string): void {
  if (isLegacyName(name)) throw new Error(REFUSAL)
}

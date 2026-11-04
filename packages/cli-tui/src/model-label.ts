import type { ConfigAccount } from '@agnes/protocol'

/** The slice of the SDK client this module needs; kept structural so tests can pass a stub. */
type ConfigClient = { config: { get(): Promise<{ accounts?: readonly ConfigAccount[] }> } }

const cache = new WeakMap<object, Map<string, string>>()

/**
 * route -> display label for each account. Two accounts sharing a label get a short accountId
 * suffix so they stay distinguishable.
 */
export function labelsOfAccounts(accounts: readonly ConfigAccount[] = []): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of accounts) {
    if (!a.label) continue
    const dup = accounts.some((o) => o !== a && o.label === a.label)
    out.set(a.route, dup ? `${a.label} #${a.accountId.replace(/^acct-/, '').slice(0, 4)}` : a.label)
  }
  return out
}

/** Store what a config snapshot already told us, so later displays need no extra read. */
export function rememberAccounts(
  client: object,
  accounts: readonly ConfigAccount[] | undefined,
): Map<string, string> {
  const labels = labelsOfAccounts(accounts)
  cache.set(client, labels)
  return labels
}

/**
 * Labels for this client: re-read when `refresh`, else the cached map, else read once.
 * Best effort: a failed config read yields an empty map (raw routes) and is not cached.
 */
export async function accountLabels(client: ConfigClient, refresh = false): Promise<Map<string, string>> {
  const known = cache.get(client)
  if (known && !refresh) return known
  try {
    return rememberAccounts(client, (await client.config.get()).accounts)
  } catch {
    return known ?? new Map()
  }
}

/** `<label> / <model>` when the route is a known account, else the raw `route/model`. */
export function modelLabel(labels: ReadonlyMap<string, string>, route: string, model: string): string {
  const label = labels.get(route)
  return label ? `${label} / ${model}` : `${route}/${model}`
}

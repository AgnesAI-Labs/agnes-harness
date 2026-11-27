import type { ModelRecord } from '@agnes/protocol'

export type CatalogueFacts = Readonly<{
  input?: ModelRecord['input']
  contextWindow: number
  maxTokens: number
}>

/** Read-only capability facts, without routes, credentials, prices or wire-specific thinking. */
export type ModelCatalogueFacts = Omit<CatalogueFacts, 'input'> &
  Readonly<{ input?: readonly ModelRecord['input'][number][] }>

/**
 * Prefer an exact provider endpoint and protocol. Elsewhere, agree by exact model id on the
 * intersection of input types and the smallest capacity. Saved accounts can disable id inference.
 * Each read owns its map, records and input arrays; absent or unreadable catalogues lend no facts.
 */
export async function readModelCatalogueFacts<
  T extends { api: string; baseUrl: string; capabilities?: unknown },
>(
  providers: readonly T[],
  read: (provider: T) => Promise<{ records: ModelRecord[] }>,
  api: string,
  address: string,
  byId = true,
): Promise<ReadonlyMap<string, CatalogueFacts>> {
  const catalogued = providers.filter((candidate) => !candidate.capabilities)
  const records = (provider: T) =>
    read(provider).then(
      (catalogue) => catalogue.records,
      () => [] as ModelRecord[],
    )
  const facts = (record: ModelRecord): CatalogueFacts => ({
    input: [...record.input],
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
  })
  const exact = catalogued.find(
    (candidate) =>
      candidate.api === api && candidate.baseUrl.replace(/\/$/, '') === address.replace(/\/$/, ''),
  )
  if (exact) return new Map((await records(exact)).map((record) => [record.id, facts(record)]))
  if (!byId) return new Map()
  const agreed = new Map<string, CatalogueFacts>()
  for (const catalogue of await Promise.all(catalogued.map(records)))
    for (const record of catalogue) {
      const prior = agreed.get(record.id)
      if (!prior) {
        agreed.set(record.id, facts(record))
        continue
      }
      const input = (prior.input ?? []).filter((type) => record.input.includes(type)) as ModelRecord['input']
      agreed.set(record.id, {
        ...(input.length ? { input } : {}),
        contextWindow: Math.min(prior.contextWindow, record.contextWindow),
        maxTokens: Math.min(prior.maxTokens, record.maxTokens),
      })
    }
  return agreed
}

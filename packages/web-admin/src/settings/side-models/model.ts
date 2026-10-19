import type {
  ConfigAccountInput,
  ConfigModel,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
} from '@agnes/protocol'

/** The one payload-only provider the account store serves today; the dropdown is a slot, not a list. */
export const SIDE_PROVIDERS = ['typesafe-systemone'] as const
export type SideProviderId = (typeof SIDE_PROVIDERS)[number]
export const draftProvider = (): SideProviderId => SIDE_PROVIDERS[0]
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export type SideModelsClient = {
  get(): Promise<ConfigSnapshot>
  save(input: ConfigSaveInput): Promise<ConfigSnapshot>
  test(input: ConfigTestInput): Promise<ConfigTestResult>
  account(input: ConfigAccountInput): Promise<ConfigSnapshot>
}

export type SideModelsCredentials = {
  list(): Promise<readonly { id: string; label: string }[]>
  create(label: string, value: string): Promise<{ id: string; label: string }>
}

export type ModelDraft = {
  key: string
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  /** The pricing fold: collapsed rows carry no cost, whatever the inputs hold. */
  showCost: boolean
  costInput: string
  costOutput: string
  costCacheRead: string
  costCacheWrite: string
}

export type EditorDraft = {
  accountId: string
  isNew: boolean
  /** The generated id a new entry falls back to when its label yields no slug. */
  fallbackId: string
  label: string
  baseUrl: string
  credentialRef: string
  models: ModelDraft[]
}

export function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const details = 'details' in error ? (error as { details?: { code?: unknown } }).details : undefined
  if (typeof details?.code === 'string') return details.code
  const data = 'data' in error ? (error as { data?: { reason?: unknown } }).data : undefined
  if (typeof data?.reason === 'string') return data.reason
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The endpoint precheck mirrors the wire layer's rules — no template, no inline credentials, no
 * query or fragment, and plain http only on loopback — so the form fails before the save round-trip.
 * The daemon re-checks every one of these.
 */
export function endpointOk(value: string): boolean {
  if (/[{}]/.test(value) || /[?#]/.test(value) || value !== value.trim()) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '' || url.hostname === '') return false
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!(host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host))) return false
  }
  return true
}

export const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const POSITIVE = /^[1-9]\d*$/
const PRICE = /^\d+(\.\d+)?$/

export function blankModel(): ModelDraft {
  return {
    key: crypto.randomUUID(),
    id: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    showCost: false,
    costInput: '',
    costOutput: '',
    costCacheRead: '',
    costCacheWrite: '',
  }
}

export function toDraft(model: ConfigModel): ModelDraft {
  return {
    key: crypto.randomUUID(),
    id: model.id,
    name: model.name,
    contextWindow: String(model.contextWindow ?? ''),
    maxTokens: String(model.maxTokens ?? ''),
    showCost: model.cost !== undefined,
    costInput: model.cost ? String(model.cost.input) : '',
    costOutput: model.cost ? String(model.cost.output) : '',
    costCacheRead: model.cost ? String(model.cost.cacheRead) : '',
    costCacheWrite: model.cost ? String(model.cost.cacheWrite) : '',
  }
}

/** The five editable fields become a stored model row; capability fields stay with the template. */
export function readModels(rows: readonly ModelDraft[]): ConfigModel[] | undefined {
  if (rows.length === 0) return undefined
  const models: ConfigModel[] = []
  for (const row of rows) {
    const costs = [row.costInput, row.costOutput, row.costCacheRead, row.costCacheWrite]
    const priced = row.showCost && costs.some((value) => value.trim() !== '')
    if (
      !MODEL_ID.test(row.id) ||
      row.name.trim() === '' ||
      row.name.length > 256 ||
      !POSITIVE.test(row.contextWindow) ||
      !POSITIVE.test(row.maxTokens) ||
      (priced && !costs.every((value) => PRICE.test(value)))
    )
      return undefined
    models.push({
      id: row.id,
      name: row.name,
      contextWindow: Number(row.contextWindow),
      maxTokens: Number(row.maxTokens),
      ...(priced
        ? {
            cost: {
              input: Number(row.costInput),
              output: Number(row.costOutput),
              cacheRead: Number(row.costCacheRead),
              cacheWrite: Number(row.costCacheWrite),
            },
          }
        : {}),
    })
  }
  return new Set(models.map((model) => model.id)).size === models.length ? models : undefined
}

/**
 * What a new entry pre-fills per adapter, so the form asks only for a credential. Every value is a
 * draft: the user can edit all of it before saving. Keyed by adapter id so the next payload-only
 * adapter gets its own entry instead of a branch.
 */
export const ADAPTER_PRESETS: Record<
  SideProviderId,
  { labelKey: string; baseUrl: string; models: () => ModelDraft[] }
> = {
  'typesafe-systemone': {
    labelKey: 'side.prefillLabel.typesafe-systemone',
    baseUrl: DEFAULT_BASE_URL,
    models: () => [
      {
        ...blankModel(),
        id: 'typesafe/jev-1.13-20260917',
        name: 'Jev 1.13 (2026-09-17)',
        contextWindow: '65536',
        maxTokens: '32768',
      },
    ],
  },
}

/**
 * The account id a new entry gets, derived from its label: lowercase kebab, within the account-id
 * rule, falling back to the generated id when the label has no ASCII letters or digits, and
 * suffixed when another account already has it.
 */
export function accountIdFor(label: string, taken: ReadonlySet<string>, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  const root = slug || fallback
  let candidate = root
  for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${root.slice(0, 44)}-${suffix}`
  return candidate
}

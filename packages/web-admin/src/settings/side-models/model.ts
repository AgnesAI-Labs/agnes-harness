import type {
  ConfigAccountInput,
  ConfigModel,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
} from '@agnes/protocol'

/** The payload-only adapters the account store serves; the first is the default for a new entry. */
export const SIDE_PROVIDERS = ['typesafe-systemone', 'openai-audio'] as const
export type SideProviderId = (typeof SIDE_PROVIDERS)[number]
export type AudioRole = NonNullable<ConfigModel['audioRole']>
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
/** Voice models have no context window or output cap of their own; these fixed values stand in. */
const VOICE_LIMITS = { contextWindow: 65536, maxTokens: 4096 } as const

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
  /** Voice side models only: the operation this row serves. */
  audioRole?: AudioRole
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
  providerId: SideProviderId
  presetId: AdapterPreset['id']
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
    ...(model.audioRole ? { audioRole: model.audioRole } : {}),
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

/**
 * The editable fields become a stored model row; capability fields stay with the template. With
 * `fixed` limits (voice models) the context window and output cap are not read from the rows.
 */
export function readModels(
  rows: readonly ModelDraft[],
  fixed?: AdapterPreset['fixedLimits'],
): ConfigModel[] | undefined {
  if (rows.length === 0) return undefined
  const models: ConfigModel[] = []
  for (const row of rows) {
    const costs = [row.costInput, row.costOutput, row.costCacheRead, row.costCacheWrite]
    const priced = row.showCost && costs.some((value) => value.trim() !== '')
    if (
      !MODEL_ID.test(row.id) ||
      row.name.trim() === '' ||
      row.name.length > 256 ||
      (!fixed && (!POSITIVE.test(row.contextWindow) || !POSITIVE.test(row.maxTokens))) ||
      (priced && !costs.every((value) => PRICE.test(value)))
    )
      return undefined
    models.push({
      id: row.id,
      name: row.name,
      contextWindow: fixed ? fixed.contextWindow : Number(row.contextWindow),
      maxTokens: fixed ? fixed.maxTokens : Number(row.maxTokens),
      ...(row.audioRole ? { audioRole: row.audioRole } : {}),
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

export type VoiceError =
  | 'side.voice.modelsRequired'
  | 'side.voice.modelsDistinct'
  | 'side.voice.fieldsInvalid'

export const VOICE_ROLES: readonly AudioRole[] = ['transcribe', 'speech']

/** A voice draft always carries one row per role, so the two fields have something to edit. */
export function voiceRows(models: readonly ModelDraft[]): ModelDraft[] {
  return VOICE_ROLES.map(
    (audioRole) => models.find((row) => row.audioRole === audioRole) ?? { ...blankModel(), audioRole },
  )
}

/**
 * What a voice entry saves: one model per filled field (name = id, fixed limits, the input price
 * when set). Output and cache prices are zero because voice usage is billed in one unit per call.
 */
export function voiceModels(
  draft: EditorDraft,
): { models: ConfigModel[]; model: string } | { error: VoiceError } {
  const rows = voiceRows(draft.models)
    .filter((row) => row.id.trim() !== '')
    .map((row) => ({
      ...row,
      name: row.id,
      showCost: row.costInput.trim() !== '',
      costOutput: '0',
      costCacheRead: '0',
      costCacheWrite: '0',
    }))
  if (rows.length === 0) return { error: 'side.voice.modelsRequired' }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return { error: 'side.voice.modelsDistinct' }
  const models = readModels(rows, VOICE_LIMITS)
  const model = models?.[0]
  return models && model ? { models, model: model.id } : { error: 'side.voice.fieldsInvalid' }
}

/**
 * What an adapter pre-fills for a new entry, so the form asks only for a credential. Every value is
 * a draft: the user can edit all of it before saving. Each adapter lists its presets, the first one
 * being its default; the voice presets differ in label, so their routes never collide.
 */
export type AdapterPreset = Readonly<{
  id: 'jev' | 'siliconflow' | 'openai' | 'stepfun'
  provider: SideProviderId
  nameKey: string
  labelKey: string
  baseUrl: string
  models(): ModelDraft[]
  fixedLimits?: Readonly<{ contextWindow: number; maxTokens: number }>
}>

const voicePreset = (
  id: 'siliconflow' | 'openai' | 'stepfun',
  baseUrl: string,
  transcribe: string,
  speech: string,
): AdapterPreset => ({
  id,
  provider: 'openai-audio',
  nameKey: `side.preset.${id}`,
  labelKey: `side.prefillLabel.${id}`,
  baseUrl,
  fixedLimits: VOICE_LIMITS,
  models: () => [
    { ...blankModel(), audioRole: 'transcribe', id: transcribe, name: transcribe },
    { ...blankModel(), audioRole: 'speech', id: speech, name: speech },
  ],
})

export const ADAPTER_PRESETS: readonly AdapterPreset[] = [
  {
    id: 'jev',
    provider: 'typesafe-systemone',
    nameKey: 'side.preset.jev',
    labelKey: 'side.prefillLabel.jev',
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
  voicePreset(
    'siliconflow',
    'https://api.siliconflow.cn/v1',
    'FunAudioLLM/SenseVoiceSmall',
    'FunAudioLLM/CosyVoice2-0.5B',
  ),
  voicePreset('openai', 'https://api.openai.com/v1', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-tts'),
  voicePreset('stepfun', 'https://api.stepfun.com/v1', 'stepaudio-3-asr-max', 'stepaudio-3-tts'),
]

export const isSideProvider = (value: string): value is SideProviderId =>
  (SIDE_PROVIDERS as readonly string[]).includes(value)

/** The model rows of a saved entry; a voice entry always gets one row per role. */
export const draftModels = (provider: SideProviderId, models: readonly ConfigModel[]): ModelDraft[] =>
  provider === 'openai-audio' ? voiceRows(models.map(toDraft)) : models.map(toDraft)

/** The presets of one adapter; the first is the default. */
export const presetsFor = (provider: SideProviderId): readonly AdapterPreset[] =>
  ADAPTER_PRESETS.filter((preset) => preset.provider === provider)

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

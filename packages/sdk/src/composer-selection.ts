import type { ThinkingLevel } from '@agnes/protocol'

export type ComposerModelRef = {
  readonly route: string
  readonly id: string
  readonly thinking?: ThinkingLevel
}

export type ComposerPermission = 'view' | 'workspace' | 'full'

export type ComposerMemory = {
  readonly model?: ComposerModelRef
  readonly permission?: ComposerPermission
}

export type AccountModelSource = {
  readonly route?: string
  readonly id?: string
  readonly model?: string
} | null

const PERMISSIONS = new Set<ComposerPermission>(['view', 'workspace', 'full'])
const THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function modelRef(value: unknown): ComposerModelRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const route = text(record.route, 64)
  const id = text(record.id, 256)
  if (!route || !id) return undefined
  const thinking = THINKING.has(record.thinking as ThinkingLevel)
    ? (record.thinking as ThinkingLevel)
    : undefined
  return { route, id, ...(thinking ? { thinking } : {}) }
}

export function parseComposerMemory(value: unknown): ComposerMemory | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const model = modelRef(record.model)
  const permission = PERMISSIONS.has(record.permission as ComposerPermission)
    ? (record.permission as ComposerPermission)
    : undefined
  if (!model && !permission) return undefined
  return { ...(model ? { model } : {}), ...(permission ? { permission } : {}) }
}

export function mergeComposerMemory(
  previous: ComposerMemory | undefined,
  update: ComposerMemory,
): ComposerMemory {
  const model = update.model ?? previous?.model
  const permission = update.permission ?? previous?.permission
  return { ...(model ? { model } : {}), ...(permission ? { permission } : {}) }
}

export function listedModel(
  models: readonly ComposerModelRef[],
  model: ComposerModelRef | undefined,
): ComposerModelRef | undefined {
  if (!model) return undefined
  const listed = models.find((item) => item.route === model.route && item.id === model.id)
  return listed && model.thinking ? { ...listed, thinking: model.thinking } : listed
}

export function accountDefaultModel(
  models: readonly ComposerModelRef[],
  provider: AccountModelSource | undefined,
): ComposerModelRef | undefined {
  const id = provider?.model
  const route = provider?.route ?? provider?.id
  if (!id || !route) return undefined
  return listedModel(models, { route, id })
}

export function resolveNewSessionSelection(input: {
  remembered: ComposerMemory | undefined
  models: readonly ComposerModelRef[]
  accountDefault?: ComposerModelRef
}): { model?: ComposerModelRef; permission: ComposerPermission } {
  const model =
    listedModel(input.models, input.remembered?.model) ?? listedModel(input.models, input.accountDefault)
  return { ...(model ? { model } : {}), permission: input.remembered?.permission ?? 'workspace' }
}

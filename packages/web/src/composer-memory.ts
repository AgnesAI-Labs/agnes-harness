import {
  type AccountModelSource,
  accountDefaultModel,
  type ComposerMemory,
  type ComposerModelRef,
  type ComposerPermission,
  mergeComposerMemory,
  parseComposerMemory,
  resolveNewSessionSelection,
} from '@agnes/sdk/composer-selection'
import { frontendBackendIdentity, selectedRemoteOrigin } from './remote-frontend.js'

let localModels: readonly ComposerModelRef[] = []

/** Native-page preferences only remember models from that backend's configured local catalog. */
export function setLocalComposerModels(models: readonly ComposerModelRef[]): void {
  localModels = models
}

export const WEB_COMPOSER_MEMORY_KEY = 'agnes-web-composer-selection'
const memoryKey = () => {
  const remote = selectedRemoteOrigin()
  return remote ? `${WEB_COMPOSER_MEMORY_KEY}:${frontendBackendIdentity()}` : WEB_COMPOSER_MEMORY_KEY
}

export function readWebComposerMemory(): ComposerMemory | undefined {
  try {
    const raw = localStorage.getItem(memoryKey())
    if (!raw) return undefined
    return parseComposerMemory(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

export function rememberWebComposer(update: ComposerMemory): void {
  if (
    update.model &&
    !selectedRemoteOrigin() &&
    !localModels.some((model) => model.route === update.model?.route && model.id === update.model.id)
  ) {
    const { model: _externalModel, ...nativeUpdate } = update
    update = nativeUpdate
    if (!Object.keys(update).length) return
  }
  const next = mergeComposerMemory(readWebComposerMemory(), {
    ...update,
    ...(update.model ? { model: { route: update.model.route, id: update.model.id } } : {}),
  })
  try {
    localStorage.setItem(memoryKey(), JSON.stringify(next))
  } catch {
    // A private browser can refuse storage. The current page still keeps the selection in memory.
  }
}

export function selectionFromMemory(
  models: readonly ComposerModelRef[],
  provider: AccountModelSource | undefined,
): { model?: ComposerModelRef; permission: ComposerPermission } {
  const accountDefault = accountDefaultModel(models, provider)
  const remembered = readWebComposerMemory()
  // Demo is a starter choice. A connected account's default takes over for future drafts;
  // an existing session and an explicit choice in the current draft keep their own model.
  const starter = remembered?.model?.route === 'demo' && remembered.model.id === 'demo-model'
  return resolveNewSessionSelection({
    remembered:
      starter && accountDefault && accountDefault.route !== 'demo'
        ? { ...remembered, model: accountDefault }
        : remembered,
    models,
    ...(accountDefault ? { accountDefault } : {}),
  })
}

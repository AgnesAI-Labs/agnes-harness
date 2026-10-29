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

export const WEB_COMPOSER_MEMORY_KEY = 'agnes-web-composer-selection'

export function readWebComposerMemory(): ComposerMemory | undefined {
  try {
    const raw = localStorage.getItem(WEB_COMPOSER_MEMORY_KEY)
    if (!raw) return undefined
    return parseComposerMemory(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

export function rememberWebComposer(update: ComposerMemory): void {
  const next = mergeComposerMemory(readWebComposerMemory(), {
    ...update,
    ...(update.model ? { model: { route: update.model.route, id: update.model.id } } : {}),
  })
  try {
    localStorage.setItem(WEB_COMPOSER_MEMORY_KEY, JSON.stringify(next))
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

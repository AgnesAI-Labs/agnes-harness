import { setLocalComposerModels } from '../composer-memory.js'
import type { ModelPickerOption } from './types.js'

/** One immutable frontend/backend context. An active cloud catalog never changes another window. */
export function contributedModelCatalog(changed?: () => void) {
  const listeners = new Set<() => void>()
  let contributed: readonly ModelPickerOption[] | undefined
  return {
    set(models: readonly ModelPickerOption[] | undefined) {
      contributed = models === undefined ? undefined : structuredClone(models)
      changed?.()
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    active: () => contributed !== undefined,
    available(models: readonly ModelPickerOption[], selected: { route: string; id: string } | undefined) {
      if (!selected) return contributed === undefined
      const matches = (model: ModelPickerOption) => model.route === selected.route && model.id === selected.id
      return models.some(matches) && (contributed === undefined || contributed.some(matches))
    },
    visible(base: ModelPickerOption[]) {
      setLocalComposerModels(base)
      if (contributed === undefined) return base
      // A UI catalog may supply only entitled IDs and labels. Keep the same backend model's
      // declared capabilities; never borrow capacity or effort levels from a different route.
      const records = new Map(base.map((model) => [JSON.stringify([model.route, model.id]), model]))
      return contributed.map((model) => ({
        ...records.get(JSON.stringify([model.route, model.id])),
        ...model,
      }))
    },
  }
}

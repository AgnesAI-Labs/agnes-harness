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
    available: (models: readonly ModelPickerOption[], selected: { route: string; id: string } | undefined) =>
      !selected || models.some((model) => model.route === selected.route && model.id === selected.id),
    visible(
      base: ModelPickerOption[],
      selected: { route: string; id: string } | undefined,
      hasSession: boolean,
    ) {
      if (contributed === undefined) return base
      const legacy =
        hasSession && selected
          ? base.filter(
              (model) =>
                model.route === selected.route &&
                model.id === selected.id &&
                !contributed?.some((entry) => entry.route === model.route && entry.id === model.id),
            )
          : []
      return [...contributed, ...legacy]
    },
  }
}

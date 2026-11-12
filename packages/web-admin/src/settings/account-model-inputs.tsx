import type { ConfigModel } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import { renderRegion, SettingsCheckbox } from '@agnes/web-ui'

/** Per-model declarations; displaying inherited types never writes an override. */
export function accountModelInputs(host: HTMLElement | undefined, changed: () => void) {
  const drafts = new Map<string, NonNullable<ConfigModel['input']>>()
  return {
    reset(): void {
      drafts.clear()
    },
    signature(): string {
      return JSON.stringify([...drafts])
    },
    models(models: readonly ConfigModel[]): ConfigModel[] {
      return models.map((model) => {
        const input = drafts.get(model.id)
        return input ? { ...model, input: [...input] } : model
      })
    },
    declarations(models: readonly ConfigModel[]): ConfigModel[] {
      return models
        .filter((model) => drafts.has(model.id))
        .map(({ id, name }) => ({ id, name, input: [...drafts.get(id)!] }))
    },
    render(model: ConfigModel | undefined, disabled: boolean): void {
      if (!host) return
      host.hidden = !model
      const selected = model && (drafts.get(model.id) ?? model.input ?? ['text'])
      renderRegion(
        host,
        model && selected ? (
          <fieldset aria-label={tr('accounts.input.types')}>
            <legend>{tr('accounts.input.types')}</legend>
            {(['text', 'image'] as const).map((type) => (
              <SettingsCheckbox
                key={type}
                label={tr(`accounts.input.${type}`)}
                value={type}
                checked={selected.includes(type)}
                disabled={disabled || (selected.length === 1 && selected.includes(type))}
                onChange={(event) => {
                  const input = (['text', 'image'] as const).filter((one) =>
                    one === type ? event.currentTarget.checked : selected.includes(one),
                  )
                  if (input.length) {
                    drafts.set(model.id, input)
                    changed()
                  }
                }}
              />
            ))}
            <p className="field-hint">{tr('accounts.input.hint')}</p>
          </fieldset>
        ) : null,
      )
    },
  }
}

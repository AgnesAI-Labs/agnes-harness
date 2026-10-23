import type { ConfigModel, ConfigTestResult } from '@agnes/protocol'
import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, Field, renderRegion, SettingsChips, SettingsChipToggle } from '@agnes/web-ui'

const MODEL_ID = /^[^\p{Cc}\p{Z}\s]{1,256}$/u

type CatalogueError = NonNullable<ConfigTestResult['catalogueError']>

/** Why the endpoint listed nothing, in the reader's words; 404 is usually a missing `/v1`. */
export function catalogueErrorText(error: CatalogueError): string {
  if (error.reason === 'http' && (error.status === 401 || error.status === 403))
    return tr('accounts.compatible.error.notConfigured')
  if (error.reason !== 'http') return tr(`accounts.compatible.error.${error.reason}`)
  return tr(error.status === 404 ? 'accounts.compatible.error.http404' : 'accounts.compatible.error.http', {
    status: String(error.status ?? ''),
  })
}

/**
 * The model list of an OpenAI-compatible account: what the endpoint listed, picked by toggling,
 * and ids typed by hand. The controller saves `models()` and offers the default model from them;
 * a listing that failed says why and leaves hand-typed ids possible.
 */
export function compatibleModelsPanel(host: HTMLElement | undefined, changed: () => void, fetch: () => void) {
  const known = new Map<string, ConfigModel>()
  let listed: string[] = []
  let chosen: string[] = []
  let error: CatalogueError | undefined
  let shown = false
  let disabled = false
  const choose = (next: readonly string[]) => {
    chosen = [...new Set(next.filter((id) => MODEL_ID.test(id)))]
    render()
    changed()
  }
  const render = () => {
    if (!host) return
    host.hidden = !shown
    if (!shown) return
    const manual = chosen.filter((id) => !listed.includes(id))
    renderRegion(
      host,
      <div className="account-field account-compatible-models">
        <div className="account-field-head">
          <Field className="form-field" label={tr('accounts.compatible.models')} />
          <Button appearance="link" size="small" htmlType="button" disabled={disabled} onClick={fetch}>
            {tr('accounts.compatible.fetch')}
          </Button>
        </div>
        <p className="field-hint">{tr('accounts.compatible.choose')}</p>
        {error && (
          <p className="field-hint" data-tone="warn" role="status">
            {`${catalogueErrorText(error)} ${tr('accounts.compatible.manualStill')}`}
          </p>
        )}
        {listed.length > 0 && (
          <SettingsChipToggle
            label={tr('accounts.compatible.listed')}
            options={listed.map((id) => ({ value: id, label: id }))}
            values={chosen.filter((id) => listed.includes(id))}
            disabled={disabled}
            onChange={(next) => choose([...next, ...manual])}
          />
        )}
        <SettingsChips
          label={tr('accounts.compatible.manual')}
          addLabel={tr('accounts.compatible.add')}
          placeholder={tr('accounts.compatible.manualPlaceholder')}
          values={manual}
          disabled={disabled}
          onChange={(next) => choose([...chosen.filter((id) => listed.includes(id)), ...next])}
        />
      </div>,
    )
  }
  return {
    show(on: boolean, off: boolean): void {
      if (shown === on && disabled === off) return
      shown = on
      disabled = off
      render()
    },
    /** A new draft: the saved account's models are chosen, nothing is listed yet. */
    reset(saved: readonly ConfigModel[]): void {
      known.clear()
      for (const model of saved) known.set(model.id, model)
      chosen = saved.map((model) => model.id)
      listed = []
      error = undefined
      render()
    },
    /** What a listing returned: its ids to pick from, or why there were none. */
    listed(result: ConfigTestResult): void {
      for (const model of result.models) if (!known.has(model.id)) known.set(model.id, model)
      listed = result.models.map((model) => model.id)
      error = result.catalogueError
      render()
    },
    /** The declared models: chosen ids, carrying what the listing or the saved account knew. */
    models(): ConfigModel[] {
      return chosen.map((id) => structuredClone(known.get(id)) ?? { id, name: id })
    },
    tested(): ConfigTestResult {
      const models = this.models()
      return { models, verified: models.length > 0 }
    },
  }
}

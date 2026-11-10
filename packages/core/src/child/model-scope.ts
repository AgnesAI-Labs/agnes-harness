import type { PresetView } from '@agnes/core-common/step/preset'
import { CoreError } from '@agnes/core-common/types'
import type { ModelRecord, Provider } from '@agnes/protocol'

/** Why the Host keeps a usable-looking model from child agents: its route has no credentials. */
export type ChildModelExclusion = 'no-credential'

/**
 * Whether a child agent may choose this model. `true` allows it. `false` excludes it without a
 * reason; a reason excludes it too, and the refusal at child creation repeats it.
 */
export type ChildModelScope = (model: Pick<ModelRecord, 'route' | 'id'>) => boolean | ChildModelExclusion

const scopes = new WeakMap<Provider, ChildModelScope>()

/**
 * The Host limits which of a provider's models a child agent can list and start on, for example the
 * models of an adapter that takes no conversation, or of a route without credentials. Only child
 * choice is limited: the provider still publishes every model, so a side call can target any of
 * them. `undefined` removes the limit.
 */
export function setChildModelScope(provider: Provider, scope: ChildModelScope | undefined): void {
  if (scope) scopes.set(provider, scope)
  else scopes.delete(provider)
}

/** The provider's models as a child agent may choose among them. */
export function childModels(provider: Provider): ModelRecord[] {
  const scope = scopes.get(provider)
  const models = provider.models()
  return scope ? models.filter((model) => scope(model) === true) : models
}

/**
 * The route and model a child agent's `model` argument names: a slot of the parent's preset, a model
 * id, or `route/id`. A model the Host excluded resolves to nothing, however it was named.
 */
export function resolveChildModel(
  provider: Provider,
  preset: PresetView,
  selector: string,
): { route: string; model: string } | undefined {
  let models: ModelRecord[]
  try {
    models = childModels(provider)
  } catch {
    return undefined
  }
  const found = pick(models, preset, selector)
  return found && (scopes.get(provider)?.({ route: found.route, id: found.model }) ?? true) === true
    ? found
    : undefined
}

/**
 * The refusal for a `model` argument that `resolveChildModel` did not resolve. When the Host gave a
 * reason for excluding the model the argument names among everything the provider publishes, the
 * refusal repeats it; a name nothing publishes, or one excluded without a reason, is only unknown.
 */
export function unresolvedChildModel(provider: Provider, preset: PresetView, selector: string): CoreError {
  const scope = scopes.get(provider)
  let found: { route: string; model: string } | undefined
  try {
    found = scope && pick(provider.models(), preset, selector)
  } catch {
    found = undefined
  }
  const reason = found && scope?.({ route: found.route, id: found.model })
  if (!found || typeof reason !== 'string')
    return new CoreError('E_MODEL_UNKNOWN', `default child factory cannot resolve model ${selector}`, {
      model: selector,
    })
  return new CoreError(
    'E_MODEL_UNKNOWN',
    `model ${selector} is not available to child agents: route ${found.route} has no credentials`,
    { model: selector, route: found.route, reason },
  )
}

function pick(
  models: readonly ModelRecord[],
  preset: PresetView,
  selector: string,
): { route: string; model: string } | undefined {
  const slotRoute = preset.model.route[selector]
  if (slotRoute !== undefined) {
    const pinned = preset.model.id[selector]
    const record = models.find(
      (item) => item.route === slotRoute && (pinned ? item.id === pinned : item.slot === selector),
    )
    const fallback = models.find((item) => item.route === slotRoute)
    const model = pinned ?? record?.id ?? fallback?.id
    return model === undefined ? undefined : { route: slotRoute, model }
  }
  const byId = models.filter((item) => item.id === selector)
  const currentRoute = preset.model.route.primary ?? 'default'
  const current = byId.find((item) => item.route === currentRoute)
  if (current) return { route: current.route, model: current.id }
  const only = byId.length === 1 ? byId[0] : undefined
  if (only) return { route: only.route, model: only.id }
  const slash = selector.indexOf('/')
  if (slash > 0) {
    const route = selector.slice(0, slash)
    const model = selector.slice(slash + 1)
    if (models.some((item) => item.route === route && item.id === model)) return { route, model }
  }
  return undefined
}

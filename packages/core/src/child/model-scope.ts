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

type Target = { route: string; model: string }

/** What excluding a model for this reason means, as the refusal says it of the route. */
const EXCLUSION_TEXT: Record<ChildModelExclusion, string> = { 'no-credential': 'has no credentials' }

/**
 * One resolution of a child agent's `model` argument: a slot of the parent's preset, a model id, or
 * `route/id`. It is resolved among the models a child may choose. When that finds nothing, the
 * models the Host excluded with a reason are searched for what the argument names, so the refusal
 * can say why.
 */
function resolve(
  provider: Provider,
  preset: PresetView,
  selector: string,
): { target: Target } | { excluded: Target & { reason: ChildModelExclusion } } | undefined {
  const scope = scopes.get(provider)
  const verdict = (target: Target) => scope?.({ route: target.route, id: target.model }) ?? true
  let all: ModelRecord[]
  try {
    all = provider.models()
  } catch {
    return undefined
  }
  const found = pick(scope ? all.filter((model) => scope(model) === true) : all, preset, selector)
  const allowed = found && verdict(found)
  if (found && allowed === true) return { target: found }
  if (found && typeof allowed === 'string') return { excluded: { ...found, reason: allowed } }
  if (!scope) return undefined
  // A slot or a unique name among everything published, then an id several excluded routes share.
  const named = pick(all, preset, selector)
  const shared = all.filter((model) => model.id === selector).map((m) => ({ route: m.route, model: m.id }))
  for (const target of [...(named ? [named] : []), ...shared]) {
    const reason = verdict(target)
    if (typeof reason === 'string') return { excluded: { ...target, reason } }
  }
  return undefined
}

/** The route and model the argument names. A model the Host excluded resolves to nothing. */
export function resolveChildModel(
  provider: Provider,
  preset: PresetView,
  selector: string,
): Target | undefined {
  const resolved = resolve(provider, preset, selector)
  return resolved && 'target' in resolved ? resolved.target : undefined
}

/**
 * The route and model the argument names, or the refusal: `E_MODEL_UNKNOWN`, which repeats the
 * Host's reason when the argument names a model it excluded with one.
 */
export function requireChildModel(provider: Provider, preset: PresetView, selector: string): Target {
  const resolved = resolve(provider, preset, selector)
  if (resolved && 'target' in resolved) return resolved.target
  if (!resolved)
    throw new CoreError('E_MODEL_UNKNOWN', `default child factory cannot resolve model ${selector}`, {
      model: selector,
    })
  const { route, reason } = resolved.excluded
  throw new CoreError(
    'E_MODEL_UNKNOWN',
    `model ${selector} is not available to child agents: route ${route} ${EXCLUSION_TEXT[reason]}`,
    { model: selector, route, reason },
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

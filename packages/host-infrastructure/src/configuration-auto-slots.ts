import type { ModelRecord } from '@agnes/protocol'

/** Id segments providers use for their light tier; read only when an account has no price metadata. */
const LIGHT_TIER = /(^|[^a-z])(flash|mini|lite|haiku|nano|fast|small)([^a-z]|$)/

const price = (model: Pick<ModelRecord, 'cost'>): number => model.cost.input + model.cost.output

/**
 * The model an unset fast slot follows, chosen from one account's own models in their saved order.
 *
 * With price metadata the cheapest model wins, by input plus output price; a model without a price
 * is never preferred to a priced one. Without any price metadata the first model whose id names a
 * light tier wins. When neither rule finds one there is no automatic choice: the slot stays unset
 * rather than borrowing a model nobody picked.
 *
 * Models named in `excluded` never win: a payload-only route's models are not conversation models,
 * however cheap or light they look.
 */
export function automaticFastModel<M extends Pick<ModelRecord, 'id' | 'cost'>>(
  models: readonly M[],
  excluded?: ReadonlySet<string>,
): M | undefined {
  const eligible = excluded === undefined ? models : models.filter((model) => !excluded.has(model.id))
  const priced = eligible.filter((model) => price(model) > 0)
  if (priced.length)
    return priced.reduce((cheapest, model) => (price(model) < price(cheapest) ? model : cheapest))
  return eligible.find((model) => LIGHT_TIER.test(model.id.toLowerCase()))
}

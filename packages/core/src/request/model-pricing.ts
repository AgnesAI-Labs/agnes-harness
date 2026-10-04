import { type ModelPriceQuote, type Provider, validModelPricePolicy } from '@agnes/protocol'

/** Capture declared estimates from the same sealed provider model snapshot used for inference. */
export function captureModelPriceQuote(
  provider: Provider,
  request: { route: string; model: string },
  admittedAt: number,
): ModelPriceQuote | null {
  if (!Number.isSafeInteger(admittedAt) || !Number.isFinite(new Date(admittedAt).getTime())) return null
  let matches: ReturnType<Provider['models']>
  try {
    matches = provider.models().filter((model) => model.route === request.route && model.id === request.model)
  } catch {
    return null
  }
  if (matches.length !== 1) return null
  const model = matches[0]
  if (!model?.cost) return null
  // An explicit policy, including incomplete or expired rates, never falls back to catalog prices.
  if (model.pricePolicy !== undefined) {
    return validModelPricePolicy(model.pricePolicy)
      ? structuredClone({
          version: 1,
          basis: 'configured',
          route: request.route,
          model: request.model,
          admittedAt,
          policy: model.pricePolicy,
        })
      : null
  }
  const rates = [model.cost.input, model.cost.cacheRead, model.cost.cacheWrite, model.cost.output]
  if (!rates.every((rate) => Number.isFinite(rate) && rate >= 0) || !rates.some((rate) => rate > 0))
    return null
  return {
    version: 1,
    basis: 'catalog-estimate',
    route: request.route,
    model: request.model,
    admittedAt,
    policy: {
      currency: 'USD',
      unit: 'per-million-tokens',
      perMillion: {
        inputUncached: model.cost.input,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
        output: model.cost.output,
      },
    },
  }
}

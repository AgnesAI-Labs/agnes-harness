import type { AlgorithmAdapterDefinition } from './authoring.js'
import {
  type AlgorithmAuthorEnvironment,
  type AlgorithmAuthorMethods,
  createAlgorithmAuthorMethods,
} from './context-authoring.js'

/** Author method slice; SDK preparePlan is composed by the trusted preparation dispatcher. */
export function createCompactionAuthorMethods<C>(
  definition: AlgorithmAdapterDefinition<'agh.compaction', C>,
  environment: AlgorithmAuthorEnvironment,
): Promise<AlgorithmAuthorMethods<'agh.compaction'>> {
  return createAlgorithmAuthorMethods(definition, environment)
}

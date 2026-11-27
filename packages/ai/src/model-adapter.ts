/** Public wire adapter reuse for installed model-provider plugins; no Host or profile mutation API. */

export { getModelCatalogueFacts } from './adapters/pi/api-key-providers.js'
export { PiAdapter } from './adapters/pi/index.js'
export type { ModelCatalogueFacts } from './catalogue-facts.js'
export { isChatModelId } from './chat-model.js'

export type ReferenceRendererRegistry = Readonly<Record<string, unknown>>

export const referenceRenderers: ReferenceRendererRegistry = Object.freeze({})

export { createReferenceUIRegistry } from './ui-registry.js'

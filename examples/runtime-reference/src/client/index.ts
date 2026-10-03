import { referenceOutlineText, referenceOutlineWeb } from './renderer.js'

export type ReferenceRendererRegistry = Readonly<Record<string, unknown>>

export const referenceRenderers: ReferenceRendererRegistry = Object.freeze({
  [referenceOutlineWeb.descriptor.id]: referenceOutlineWeb,
  [referenceOutlineText.descriptor.id]: referenceOutlineText,
})

export { referenceOutlineText, referenceOutlineWeb } from './renderer.js'
export { createReferenceUIRegistry } from './ui-registry.js'

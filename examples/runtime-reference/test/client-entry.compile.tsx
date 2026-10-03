import type { IMRenderer, TextRenderer, WebRendererDefinition } from '@agnes/extension-api/client'
import {
  type ReferenceRendererRegistry,
  referenceOutlineText,
  referenceOutlineWeb,
  referenceRenderers,
} from '@agnes-examples/runtime-reference/client'
import type { ReactElement } from 'react'

export const renderReferenceRegistry = (
  registry: ReferenceRendererRegistry = referenceRenderers,
): ReactElement => <span>{Object.keys(registry).length}</span>

// The browser entry mirrors the renderer shapes; these assignments keep the mirrors in step.
export const web: WebRendererDefinition = referenceOutlineWeb
export const text: TextRenderer = referenceOutlineText
export const im: IMRenderer = referenceOutlineText

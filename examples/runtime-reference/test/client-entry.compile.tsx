import { type ReferenceRendererRegistry, referenceRenderers } from '@agnes-examples/runtime-reference/client'
import type { ReactElement } from 'react'

export const renderReferenceRegistry = (
  registry: ReferenceRendererRegistry = referenceRenderers,
): ReactElement => <span>{Object.keys(registry).length}</span>

// The web client's default renderer: the built-in presentation of a domain view under the descriptor a
// catalog declares for it. Web shows the generic card, the text targets the SDK's default text format and
// IM encodes that text with the SDK's channel encoder, so the default adds no rendering of its own.
import type { IMRenderer, RendererDescriptor, WebRendererDefinition } from '@agnes/extension-api/client'
import { encodeForChannel, formatDomainView } from '@agnes/sdk/runtime'
import { GenericDomainView } from '../renderers/generic.js'

export const createDefaultRenderer = (
  descriptor: RendererDescriptor,
): WebRendererDefinition & IMRenderer => ({
  descriptor,
  component: GenericDomainView,
  format: formatDomainView,
  encode: encodeForChannel,
})

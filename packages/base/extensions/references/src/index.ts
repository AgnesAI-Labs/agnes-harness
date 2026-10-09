import type { ProviderPluginContext, ReferenceResolver } from '@agnes/extension-api'
import { defineProvider } from '@agnes/plugin-runtime'

export const fileReferenceResolver = defineProvider('reference-resolver', {
  id: 'file',
  version: '1.0.0',
  search: (query, context) => context.files.search(query),
  resolve: (id, context) => context.files.read(id),
} satisfies ReferenceResolver)
export const sessionReferenceResolver = defineProvider('reference-resolver', {
  id: 'session',
  version: '1.0.0',
  search: (query, context) => context.sessions.search(query),
  resolve: (id, context) => context.sessions.read(id),
} satisfies ReferenceResolver)

export const referenceResolversPlugin = {
  inject: { providers: { required: true } },
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register('reference-resolver', '@agnes/base', fileReferenceResolver)
    ctx.providers.register('reference-resolver', '@agnes/base', sessionReferenceResolver)
  },
}

import type { ProviderPluginContext, ReferenceResolver } from '@agnes/extension-api'
import { referenceResolverKind } from '@agnes/extension-api'
import { defineProvider } from '@agnes/plugin-runtime'

export const fileReferenceResolver = defineProvider(referenceResolverKind, {
  id: 'file',
  version: '1.0.0',
  search: (query, context) => context.files.search(query),
  resolve: (id, context) => context.files.read(id),
} satisfies ReferenceResolver)
export const sessionReferenceResolver = defineProvider(referenceResolverKind, {
  id: 'session',
  version: '1.0.0',
  search: (query, context) => context.sessions.search(query),
  resolve: (id, context) => context.sessions.read(id),
} satisfies ReferenceResolver)

export const referenceResolversPlugin = {
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(referenceResolverKind, fileReferenceResolver)
    ctx.providers.register(referenceResolverKind, sessionReferenceResolver)
  },
}

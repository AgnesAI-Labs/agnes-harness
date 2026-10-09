import { type Context, Service } from '@agnes/cordis'
import {
  defineProviderKind,
  type ReferenceContext,
  type ReferenceResolver,
  type ReferenceResolverPort,
} from '@agnes/extension-api'
import { installProviderRegistry, type ProviderRegistry } from '@agnes/host-common/assemble/provider-registry'
import { type ContentBlock, type ReferenceSelection, validateReferenceSelections } from '@agnes/protocol'
import { boundReferenceText, fenceReference, referenceLimits } from './reference-text.js'

const kind = defineProviderKind<ReferenceResolver>({
  kind: 'reference-resolver',
  scope: 'generation',
  validate(provider) {
    if (typeof provider.search !== 'function' || typeof provider.resolve !== 'function')
      throw new TypeError('Reference resolver requires search and resolve')
  },
})

declare module '@agnes/cordis' {
  interface Context {
    referenceResolvers: ReferenceResolversService
  }
}

export class ReferenceResolversService extends Service implements ReferenceResolverPort {
  readonly registry: ProviderRegistry<ReferenceResolver>
  constructor(ctx: Context) {
    super(ctx, 'referenceResolvers')
    this.registry = installProviderRegistry(ctx, kind)
  }
  async search(query: string, context: ReferenceContext) {
    if (typeof query !== 'string' || query.length > 256) throw new Error('Invalid reference query.')
    context.signal.throwIfAborted()
    const all = this.registry.values()
    const prefix = /^(\S+)(?:\s+(.*))?$/u.exec(query)
    const source = all.find((p) => p.id === prefix?.[1])
    const providers = source ? [source] : all
    const pages = await Promise.all(
      providers.map(async (p) => {
        const result = await p.search(source ? (prefix?.[2] ?? '') : query, context)
        context.signal.throwIfAborted()
        return { ...result, items: result.items.map((item) => ({ ...item, source: p.id })) }
      }),
    )
    const items = pages.flatMap((page) => page.items).slice(0, 40)
    for (const item of items) {
      validateReferenceSelections([{ source: item.source, id: item.id }])
      if (
        typeof item.label !== 'string' ||
        item.label.length > 4096 ||
        (item.description !== undefined &&
          (typeof item.description !== 'string' || item.description.length > 4096))
      )
        throw new Error('Invalid reference candidate.')
    }
    return {
      items,
      truncated: pages.some((p) => p.truncated) || pages.reduce((n, p) => n + p.items.length, 0) > 40,
    }
  }
  async resolve(
    selections: readonly ReferenceSelection[],
    context: ReferenceContext,
  ): Promise<ContentBlock[]> {
    const unique = new Map(validateReferenceSelections(selections).map((s) => [`${s.source}\0${s.id}`, s]))
    const limits = referenceLimits(context.limits)
    const blocks: ContentBlock[] = []
    for (const selection of unique.values()) {
      context.signal.throwIfAborted()
      const value = await this.registry
        .resolve(selection.source)
        .resolve(selection.id, { ...context, limits })
      context.signal.throwIfAborted()
      if (
        !/^[a-f0-9]{64}$/.test(value.hash) ||
        typeof value.text !== 'string' ||
        typeof value.label !== 'string' ||
        value.label.length > 4096 ||
        typeof value.truncated !== 'boolean'
      )
        throw new Error('Invalid reference resolution.')
      const bounded = boundReferenceText(value.text, limits)
      const reference = {
        ...selection,
        label: value.label,
        hash: value.hash,
        truncated: value.truncated || bounded.truncated,
      }
      blocks.push({ type: 'text', text: fenceReference(reference, bounded.text), reference })
    }
    return blocks
  }
}

/** Install the public kind; official and community providers arrive from plugin rows. */
export function installReferenceResolvers(ctx: Context): ReferenceResolversService {
  return new ReferenceResolversService(ctx)
}

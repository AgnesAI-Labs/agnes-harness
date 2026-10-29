import type { ComponentType } from 'react'
import { ownContribution } from './contribution-scope.js'
import type { ModuleIdentity } from './service-contracts.js'
import { homeNavigation, type UiExtensionContext, UiExtensionRegistry } from './ui-registries.js'

export type ExamplePageContribution = Readonly<{
  id: string
  component: ComponentType<{ context: UiExtensionContext }>
}>
const pages = new UiExtensionRegistry<ExamplePageContribution & { order: number; module: ModuleIdentity }>()
/** Each page's component closes over its own module context and profile effect scope. */
export function scopedExamplePages(module: ModuleIdentity, effect: (off: () => void) => void) {
  let live = true
  ownContribution(
    module.binding?.owner ?? module.rowId ?? module.packageId,
    () => {
      live = false
    },
    effect,
  )
  return Object.freeze({
    register(page: ExamplePageContribution): () => void {
      if (
        !live ||
        module.binding?.lifetime !== 'profile' ||
        module.binding.availability !== 'active' ||
        !module.exampleOf ||
        module.pageEntry !== page.id ||
        !module.examplePages?.includes(page.id)
      )
        throw new Error('Undeclared example page')
      const off = pages.register({ ...page, id: pageKey(module.packageId, page.id), order: 0, module })
      return ownContribution(module.binding.owner, off, effect)
    },
    render(exampleId: string, context: UiExtensionContext) {
      if (!live || module.binding?.lifetime !== 'profile' || module.binding.availability !== 'active')
        return null
      const page = pages
        .entries()
        .find((page) => page.module.packageId === exampleId && page.module.exampleOf === module.packageId)
      if (!page) return null
      const Component = page.component
      return <Component context={context} />
    },
    subscribe: pages.subscribe,
    getSnapshot: pages.getSnapshot,
    open(exampleId: string) {
      if (!live) throw new Error('Example page host unavailable')
      const page = pages
        .entries()
        .find((page) => page.module.packageId === exampleId && page.module.exampleOf === module.packageId)
      if (!page) throw new Error('Example page unavailable')
      const home = module.homeEntries?.[0]
      if (!home) throw new Error('Example page host unavailable')
      homeNavigation.open(home.id, { exampleId })
    },
  })
}
function pageKey(packageId: string, id: string): string {
  return `example.${[...new TextEncoder().encode(`${packageId}/${id}`)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

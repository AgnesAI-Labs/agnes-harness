import { homeNavigation, type LocaleService, reserveHomeEntry } from '@agnes/web-client'
import { useEffect } from 'react'
import type { ReadyClientModule } from './contracts.js'

/** Navigation is a roster fact; executing a page module waits for a person's first open. */
export function createRosterNavigation(locale?: LocaleService) {
  const rows = new Map<string, { signature: string; opened: boolean; dispose(): void }>()
  function remove(rowId: string) {
    rows.get(rowId)?.dispose()
    rows.delete(rowId)
  }
  function prepare(rowId: string, module: ReadyClientModule, load: () => void): boolean {
    const declarations = module.homeEntries?.filter(
      (entry) => entry.placement === 'primary' && entry.navigation,
    )
    if (
      module.binding?.lifetime !== 'profile' ||
      module.binding.availability !== 'active' ||
      !declarations?.length
    )
      return false
    const signature = JSON.stringify([module.revision, module.entryUrl, module.binding, declarations])
    if (rows.get(rowId)?.signature !== signature) {
      remove(rowId)
      const cleanups: (() => void)[] = []
      const state = {
        signature,
        opened: false,
        dispose: () => {
          for (const off of cleanups.reverse()) off()
        },
      }
      rows.set(rowId, state)
      const open = () => {
        if (state.opened || rows.get(rowId) !== state) return
        state.opened = true
        load()
      }
      try {
        for (const entry of declarations) {
          const metadata = entry.navigation
          if (!metadata) continue
          const titleKey = `home.declared.${entry.id}`
          if (locale) {
            const catalog = Object.fromEntries(
              Object.entries({ en: metadata.title, ...metadata.titles }).map(([language, title]) => [
                language,
                { [titleKey]: title },
              ]),
            )
            cleanups.push(locale.register(`home:${rowId}:${entry.id}`, catalog))
          }
          function PendingPage() {
            useEffect(open, [])
            return <p role="status">{locale?.t('loading') ?? '…'}</p>
          }
          cleanups.push(
            reserveHomeEntry(module.binding.owner, {
              id: entry.id,
              placement: entry.placement,
              titleKey: locale ? titleKey : metadata.title,
              icon: metadata.icon,
              order: metadata.order,
              component: PendingPage,
            }),
          )
        }
        const selected = () => {
          if (declarations.some((entry) => entry.id === homeNavigation.getSnapshot()?.id)) open()
        }
        cleanups.push(homeNavigation.subscribe(selected))
        selected()
      } catch (error) {
        remove(rowId)
        throw error
      }
    }
    return !rows.get(rowId)?.opened
  }
  return {
    prepare,
    remove,
    retain(ids: ReadonlySet<string>) {
      for (const id of rows.keys()) if (!ids.has(id)) remove(id)
    },
  }
}

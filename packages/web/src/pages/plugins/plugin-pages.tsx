import { resolvePluginMetadata } from '@agnes/protocol'
import { usePushStack } from '@agnes/web-ui'
import { useRef } from 'react'
import type { PluginView } from './admin-view.js'
import { type HostedOpen, HostedPage, useHostedDialog } from './hosted-pages.js'
import { pluginPage, pluginPageId } from './route.js'

const DETAIL_KINDS = new Set(['plugin', 'market', 'operations'])

/**
 * The plugin controller's detail and its Add plugin form, as pages of the plugins page: an installed
 * plugin is `plugin:<id>`, a marketplace entry `market:<id>`, running operations `operations` (opened
 * from the page's activity line, never by an install), and the form `add-plugin`.
 */
export function PluginPages({ view }: { view: PluginView | undefined }) {
  const latest = useRef(view)
  latest.current = view
  const { stack } = usePushStack()
  const name = (id: string, metadata: Parameters<typeof resolvePluginMetadata>[0]) =>
    resolvePluginMetadata(metadata, view?.locale.getSnapshot() ?? 'en')?.displayName ?? id
  const detail = useHostedDialog({
    id: 'plugin-detail',
    ready: view,
    owns: (segment) => DETAIL_KINDS.has(pluginPage(segment)?.kind ?? ''),
    pageOf: () => {
      const state = latest.current?.state
      if (state?.selectedId) return pluginPageId({ kind: 'plugin', id: state.selectedId })
      if (state?.selectedCatalog) return pluginPageId({ kind: 'market', id: state.selectedCatalog.id })
      return pluginPageId({ kind: 'operations' })
    },
    open: (segment): HostedOpen => {
      const current = latest.current
      const page = pluginPage(segment)
      if (!current || current.state.loading) return 'pending'
      if (page?.kind === 'plugin') {
        if (current.tab !== 'installed') return 'pending'
        const item = current.state.installed.find((entry) => entry.id === page.id)
        if (!item) return 'missing'
        current.selectItem(item)
        return 'opened'
      }
      if (page?.kind === 'market') {
        if (current.tab !== 'discover') return 'pending'
        const item = current.state.catalog.find((entry) => entry.id === page.id)
        if (!item) return 'missing'
        current.selectItem(item)
        return 'opened'
      }
      // Running operations open on request; a link to them after they finished is stale.
      if (page?.kind === 'operations' && current.state.operations.size > 0) {
        current.openOperations()
        return 'opened'
      }
      return 'missing'
    },
  })
  const source = useHostedDialog({
    id: 'source-dialog',
    ready: view,
    owns: (segment) => segment === 'add-plugin',
    pageOf: () => 'add-plugin',
    open: () => {
      const current = latest.current
      // What the reader may do is known once the first read has finished.
      // A completed check is replacing this form; a stale route must not open it again.
      if (!current || current.state.loading || current.review) return 'pending'
      if (!current.canEffect('packages.install')) return 'missing'
      current.openSourceDialog('install')
      return 'opened'
    },
  })
  const title = (segment: string) => {
    const page = pluginPage(segment)
    const state = view?.state
    if (page?.kind === 'plugin') {
      const item = state?.installed.find((entry) => entry.id === page.id)
      return item ? name(item.id, item.metadata) : page.id
    }
    if (page?.kind === 'market') {
      const item = state?.selectedCatalog?.id === page.id ? state.selectedCatalog : undefined
      return item ? name(item.id, item.metadata) : page.id
    }
    if (page?.kind === 'add-plugin') return view?.sourceTitle() ?? ''
    return view?.t('detail.heading.operations') ?? ''
  }
  return (
    <>
      {stack
        .filter((segment) => DETAIL_KINDS.has(pluginPage(segment)?.kind ?? '') || segment === 'add-plugin')
        .map((segment) => (
          <HostedPage
            key={segment}
            segment={segment}
            host={segment === 'add-plugin' ? source : detail}
            title={title(segment)}
          />
        ))}
    </>
  )
}

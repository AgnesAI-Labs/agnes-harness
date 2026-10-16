import type { PackageInstalledDescriptor, PackagePreview } from '@agnes/protocol'
import { homeNavigation } from '@agnes/web-client'
import { Banner, Button } from '@agnes/web-ui'
import type { AdminPageState } from '../types.js'
import type { PluginAdminPage } from './page.js'

type Example = Pick<PackageInstalledDescriptor, 'id' | 'metadata'>
type ManagementView = {
  state: Pick<AdminPageState, 'installed'>
  t(key: string, vars?: Readonly<Record<string, string | number>>): string
}
type Management = {
  parentId: string
  parent: PackageInstalledDescriptor | undefined
  available: boolean
  message: string
}
export function exampleManagement(view: ManagementView, item: Example): Management | undefined {
  const parentId = item.metadata?.exampleOf
  if (!parentId) return undefined
  const parent = view.state.installed.find((row) => row.id === parentId)
  const available =
    !!parent?.trusted &&
    parent.desired === 'enabled' &&
    parent.actual === 'running' &&
    !parent.blockers.length
  const reason = !parent ? 'missing' : available ? 'managed' : 'disabled'
  return { parentId, parent, available, message: view.t(`example.parent.${reason}`, { parent: parentId }) }
}

/** Examples have one management surface; the ordinary admin never installs or activates them. */
export function manageExample(page: PluginAdminPage, item: Example): boolean {
  const view = page.viewContext()
  const state = exampleManagement(view, item)
  if (!state) return false
  page.configureConfirm({
    title: () => view.t('example.parent.title'),
    description: () => exampleManagement(page.viewContext(), item)?.message ?? '',
    label: () => view.t(state.available ? 'example.parent.open' : 'example.parent.review'),
    run: async () => {
      if (!state.parent) {
        await page.chooseUpdateVersion({ id: state.parentId })
        const catalog = page.viewContext().state.catalog.find((row) => row.id === state.parentId)
        if (catalog) await page.inspectCatalog(catalog)
        return
      }
      const entry = state.parent.contributions.flatMap((c) =>
        'client' in c ? (c.client?.homeEntries ?? []) : [],
      )[0]
      if (state.available && entry) homeNavigation.open(entry.id, { exampleId: item.id })
      else {
        await page.selectTab('installed')
        page.selectItem(state.parent)
      }
    },
  })
  return true
}

export function ExampleManagementNotice({
  view,
  preview,
}: {
  view: ManagementView & { manageExample(item: Example): boolean }
  preview: PackagePreview
}) {
  const state = exampleManagement(view, preview)
  if (!state) return null
  return (
    <Banner tone="warning" data-testid="example-parent-management">
      {state.message}
      <Button onClick={() => view.manageExample(preview)}>
        {view.t(state.available ? 'example.parent.open' : 'example.parent.review')}
      </Button>
    </Banner>
  )
}

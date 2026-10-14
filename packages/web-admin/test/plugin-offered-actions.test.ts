import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { offeredActions } from '../src/admin/plugins/admin/confirms.js'
import type { PluginAdminPage } from '../src/admin/plugins/admin/page.js'

const actions = [
  { label: 'Check for updates', group: 'versions', className: '', onClick: () => undefined },
  { label: 'Revoke trust', group: 'trust', className: '', onClick: () => undefined },
  { label: 'Uninstall', group: 'versions', danger: true, className: '', onClick: () => undefined },
]
const page = { detailActions: () => actions } as unknown as PluginAdminPage
const plugin = (ref: string, origin: string) =>
  ({
    id: '@agnes/skill-helper',
    source: { type: 'file', ref },
    presentation: { origin, rows: [] },
  }) as unknown as PackageInstalledDescriptor

it('never offers to uninstall what ships with the product, and keeps its other actions', () => {
  const offered = offeredActions(page)(plugin('file:./bundled-plugins/skill-helper', 'official'))
  expect(offered.map((action) => action.label)).toEqual(['Check for updates', 'Revoke trust'])
})

it('offers every action for a plugin the user installed', () => {
  expect(offeredActions(page)(plugin('file:./my-plugins/skill-helper', 'local-source'))).toHaveLength(3)
  expect(offeredActions(page)(plugin('npm:@agnes/skill-helper@1.0.0', 'official'))).toHaveLength(3)
})

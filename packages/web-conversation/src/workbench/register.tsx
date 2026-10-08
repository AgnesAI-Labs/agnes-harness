import { workbenchPanels } from '@agnes/web-client'
import { FilesPanel } from './files-panel.js'

if (!workbenchPanels.get('files'))
  workbenchPanels.register({
    id: 'files',
    order: 10,
    edge: 'right',
    titleKey: 'workbench.files.title',
    component: FilesPanel,
  })

export type { WorkbenchContext } from './context.js'
export { workbenchLocaleCatalog } from './locales.js'

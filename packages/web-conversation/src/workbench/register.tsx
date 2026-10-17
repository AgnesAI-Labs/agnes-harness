import { fileViewerActions, workbenchPanels } from '@agnes/web-client'
import { ChangesPanel, ReviewFileAction } from './changes-panel.js'
import { FilesPanel } from './files-panel.js'
import { changesCount } from './tab-counts.js'

export { terminalCount } from './tab-counts.js'
export { TerminalPanel } from './terminal-panel.js'

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

if (!workbenchPanels.get('changed-files'))
  workbenchPanels.register({
    id: 'changed-files',
    order: 30,
    edge: 'right',
    titleKey: 'workbench.changes.title',
    count: changesCount,
    component: ChangesPanel,
  })
if (!fileViewerActions.get('review'))
  fileViewerActions.register({ id: 'review', order: 10, component: ReviewFileAction })

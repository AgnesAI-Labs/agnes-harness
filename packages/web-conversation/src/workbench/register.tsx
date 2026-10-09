import { workbenchPanels } from '@agnes/web-client'
import { FactChainPanel } from './fact-chain-panel.js'
import { FilesPanel } from './files-panel.js'

if (!workbenchPanels.get('files'))
  workbenchPanels.register({
    id: 'files',
    order: 10,
    edge: 'right',
    titleKey: 'workbench.files.title',
    component: FilesPanel,
  })

if (!workbenchPanels.get('facts'))
  workbenchPanels.register({
    id: 'facts',
    order: 40,
    edge: 'right',
    titleKey: 'facts.title',
    component: FactChainPanel,
  })

export type { WorkbenchContext } from './context.js'
export { workbenchLocaleCatalog } from './locales.js'

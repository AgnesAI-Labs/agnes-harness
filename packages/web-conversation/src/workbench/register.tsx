import { workbenchPanels } from '@agnes/web-client'
import { FactChainPanel } from './fact-chain-panel.js'
import { FilesPanel } from './files-panel.js'
import { GoalPanel } from './goal-panel.js'
import { TerminalPanel } from './terminal-panel.js'

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

if (!workbenchPanels.get('terminal'))
  workbenchPanels.register({
    id: 'terminal',
    order: 10,
    edge: 'bottom',
    titleKey: 'workbench.terminal.title',
    component: TerminalPanel,
  })

if (!workbenchPanels.get('goal'))
  workbenchPanels.register({
    id: 'goal',
    order: 20,
    edge: 'right',
    titleKey: 'workbench.goal.title',
    component: GoalPanel,
  })

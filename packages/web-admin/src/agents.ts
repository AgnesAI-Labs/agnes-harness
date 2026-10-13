/** Business agents (FDE): the gallery page and the one-click start other surfaces reuse. */
export {
  type BusinessAgent,
  type BusinessAgentState,
  businessAgentState,
  businessAgentView,
  isBusinessAgent,
  readBusinessAgents,
  samplePromptOf,
  suggestedBusinessAgents,
} from './agents/catalog.js'
export {
  BusinessAgentGallery,
  type BusinessAgentsData,
  type BusinessAgentsSource,
  useBusinessAgents,
} from './agents/gallery.js'
export { AGENTS_NAMESPACE, agentsCatalog } from './agents/locale.js'
export {
  type BusinessAgentStart,
  openStartedSession,
  type StartedSession,
  useBusinessAgentStart,
} from './agents/start-dialog.js'
export {
  planBusinessAgentStart,
  runBusinessAgentStart,
  START_STEPS,
  type StartApi,
  StartError,
  type StartFailure,
  type StartPlan,
  type StartProgress,
  type StartStep,
  type StartTarget,
} from './agents/start-flow.js'

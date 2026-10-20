/** Agents: the gallery page and the one-click start other surfaces reuse. */

export { AGENTS_NAMESPACE, agentsCatalog } from './agents/agents-locale.js'
export { ApplicationCard } from './agents/application-card.js'
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
export { discoverableAgent, exampleDiscovery } from './agents/discovery.js'
export {
  BusinessAgentGallery,
  type BusinessAgentsData,
  type BusinessAgentsSource,
  useBusinessAgents,
} from './agents/gallery.js'
export { AgentLaunchReview } from './agents/launch-review.js'
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

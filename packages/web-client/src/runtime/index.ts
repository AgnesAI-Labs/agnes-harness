// The `@agnes/web-client/runtime` entry: what a Web client host runs the runtime client with. It
// resolves the server-chosen client selection, hosts the selected modules and their renderers, and
// merges a session's conversation window. The author API stays on the package root.
export {
  type ClientGeneration,
  type ClientHostRuntime,
  type ClientModuleLoader,
  createClientHostRuntime,
} from './client-host.js'
export {
  type ClientSelection,
  type ClientTarget,
  type ResolvedClientSelection,
  resolveClientSelection,
} from './client-selection.js'
export {
  type ConversationWindowMerger,
  type ConversationWindowStatus,
  createConversationWindow,
  type WindowStep,
} from './conversation-window.js'
export { type AuthorizedViews, createRendererPresenter } from './renderer-presentation.js'

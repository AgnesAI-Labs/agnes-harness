import { claudeCodeChildAgentsPlugin } from '../../subagent-claude-code/src/provider.js'
import { codexChildAgentsPlugin } from '../../subagent-codex/src/provider.js'
import type { ChildEngineSettings } from './document.js'
import { sdkChildAgentsPlugin } from './provider.js'

export {
  CHILD_ENGINE_CAPABILITIES,
  type ChildEngineSettings,
  childEngineSettingsError,
  commandAllowed,
  DISABLED_CHILD_ENGINES,
  type EngineDocument,
  parseChildEngineSettings,
} from './document.js'

/** Plugins for the saved document. A disabled engine registers nothing. */
export function childEnginePlugins(settings: ChildEngineSettings) {
  return [
    codexChildAgentsPlugin(settings.codex),
    claudeCodeChildAgentsPlugin(settings.claudeCode),
    sdkChildAgentsPlugin(settings.sdk),
  ]
}

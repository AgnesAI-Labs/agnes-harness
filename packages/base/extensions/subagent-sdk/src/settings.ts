import type { ChildAgentPluginContext } from '@agnes/extension-api'
import { claudeCodeChildAgentsPlugin } from '../../subagent-claude-code/src/provider.js'
import { codexChildAgentsPlugin } from '../../subagent-codex/src/provider.js'
import type { ChildEngineSettings } from './document.js'
import { sdkChildAgentsPlugin } from './provider.js'

export {
  CHILD_ENGINE_CAPABILITIES,
  CHILD_ENGINE_ROW_IDS,
  type ChildEngineSettings,
  childEngineRowConfig,
  childEngineSettingsError,
  commandAllowed,
  DISABLED_CHILD_ENGINES,
  type EngineDocument,
  parseChildEngineSettings,
  readChildEngineSettings,
  readEngineDocument,
  readSdkEngineDocument,
} from './document.js'

/** Plugins for the saved document. A disabled engine registers nothing. */
export function childEnginePlugins(settings: ChildEngineSettings) {
  return [
    {
      inject: ['childAgents'] as const,
      apply(ctx: ChildAgentPluginContext) {
        return codexChildAgentsPlugin.apply(ctx, settings.codex)
      },
    },
    {
      inject: ['childAgents'] as const,
      apply(ctx: ChildAgentPluginContext) {
        return claudeCodeChildAgentsPlugin.apply(ctx, settings.claudeCode)
      },
    },
    {
      inject: ['childAgents'] as const,
      apply(ctx: ChildAgentPluginContext) {
        return sdkChildAgentsPlugin.apply(ctx, settings.sdk)
      },
    },
  ]
}

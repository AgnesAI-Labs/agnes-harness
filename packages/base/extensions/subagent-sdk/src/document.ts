/** Browser-safe child engine configuration. It does not spawn processes. */
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
} from '@agnes/protocol'

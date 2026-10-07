import { type ChildEngineSettings, DISABLED_CHILD_ENGINES, readChildEngineSettings } from '@agnes/protocol'

/** Browser-safe child engine configuration. It does not spawn processes. */
export {
  CHILD_ENGINE_ROW_IDS,
  type ChildEngineSettings,
  childEngineRowConfig,
  childEngineSettingsError,
  commandAllowed,
  DISABLED_CHILD_ENGINES,
  type EngineDocument,
  readChildEngineSettings,
  readEngineDocument,
  readSdkEngineDocument,
} from '@agnes/protocol'

const oneShot = Object.freeze({
  continuable: false,
  interrupt: true,
  modelSelection: false,
  inheritsParentContext: false,
  worktree: false,
  budget: false,
  toolFilter: false,
})

/** Capability flags the settings page shows. Providers must match these values. */
export const CHILD_ENGINE_CAPABILITIES = Object.freeze({
  codex: oneShot,
  'claude-code': oneShot,
  sdk: oneShot,
  acp: Object.freeze({ ...oneShot, continuable: true }),
})

export function parseChildEngineSettings(value: unknown): ChildEngineSettings {
  return readChildEngineSettings(value) ?? structuredClone(DISABLED_CHILD_ENGINES)
}

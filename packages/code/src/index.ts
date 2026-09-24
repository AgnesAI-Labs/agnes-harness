// Root export surface of the product shell. Grows one block per task; test/boundary.test.ts pins it
// in both directions, so adding a name here without adding it there fails.
import { loadAllPresets } from './presets/load.js'

export const PACKAGE_ID = '@agnes/code' as const

export {
  loadAllPresets,
  loadPreset,
  MINIMAL_RL_SHA256,
  PRESET_NAMES,
  PRESETS_DIR,
  type PresetDoc,
  type PresetName,
  readFrozenSha256,
  verifyFrozenPreset,
} from './presets/load.js'

/** The named export the host reads when it assembles this package's recipes. */
export const presets = loadAllPresets()

export {
  type EnvironmentFacts,
  type RuntimeSnapshotFacts,
  renderEnvironment,
  renderTools,
} from './extensions/code-mode/environment.js'
export {
  createPromptOperation,
  environmentFacts,
  type PromptDeps,
  runtimeSnapshotFacts,
} from './extensions/code-mode/prompts.js'
export {
  applyVars,
  loadPrompt,
  PROMPT_SECTIONS,
  type PromptSectionSpec,
  renderPersona,
  sectionOrder,
  stripFrontmatter,
  validateSections,
} from './prompts/sections.js'

import codeModeExtension from './extensions/code-mode/index.js'
import { createPromptOperation } from './extensions/code-mode/prompts.js'

/**
 * The factory table the host reads as `PackageModule.operations`. It is the only path by which this
 * package's prompt reaches a request: the host calls each factory once at assembly with the
 * dependencies an operation cannot construct for itself, and the kernel calls the operation's
 * contribute() on every request.
 */
export const operations = { prompts: createPromptOperation }

/** Trusted factory table used by Host for both package-directory and SEA-embedded discovery. */
export const ecosystem = { 'agnes/code-mode': () => codeModeExtension } as const

export {
  BRIDGE_METHODS,
  type BridgeMethod,
  createBridge,
  hasBridgeCode,
  toBridgeError,
} from './extensions/code-mode/bridge.js'
export {
  CODE_MODE_EVENTS,
  CODE_MODE_EXT_ID,
  type CodeModeEvent,
  default as codeModeExtension,
} from './extensions/code-mode/index.js'
export { type RunLimits, readLimits } from './extensions/code-mode/limits.js'
export { type GuardedOutput, guardOutput } from './extensions/code-mode/output.js'
export {
  type BridgeHandler,
  createRunCodeTool,
  type RunCodeArgs,
  type RunCodeDeps,
  RunCodeParams,
} from './extensions/code-mode/run-code.js'
export {
  RUN_CODE_FLAVORS,
  type RunCodeFlavor,
  runCodeDescription,
} from './extensions/code-mode/sdk/flavors.js'
export { createSdkRenderer, type SdkRenderer, snapshotKey } from './extensions/code-mode/sdk/memo.js'
export {
  annotate,
  PY_RESERVED,
  pythonBinding,
  renderPython,
  type SkipReason,
} from './extensions/code-mode/sdk/render-python.js'
export { type DoctorCheck, type DoctorSection, runtimeDoctor } from './runtime/doctor.js'

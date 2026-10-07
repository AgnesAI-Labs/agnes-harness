import { commandAllowed } from './launch.js'

/** Browser-safe child engine configuration. It does not spawn processes. */
export { commandAllowed } from './launch.js'

export type EngineDocument = {
  enabled: boolean
  command: string
  args: string[]
  allow: string[]
}

export type ChildEngineSettings = {
  codex: EngineDocument
  claudeCode: EngineDocument
  sdk: EngineDocument & { protocol: 'sdk' | 'acp' }
}

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

export const DISABLED_CHILD_ENGINES: ChildEngineSettings = {
  codex: {
    enabled: false,
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '--color', 'never'],
    allow: [],
  },
  claudeCode: {
    enabled: false,
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk'],
    allow: [],
  },
  sdk: { enabled: false, protocol: 'sdk', command: '', args: [], allow: [] },
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value.map((item) => item)
}

function launch(value: unknown): EngineDocument | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const args = stringList(record.args)
  const allow = stringList(record.allow)
  if (typeof record.enabled !== 'boolean' || typeof record.command !== 'string' || !args || !allow)
    return undefined
  return { enabled: record.enabled, command: record.command, args, allow }
}

export function parseChildEngineSettings(value: unknown): ChildEngineSettings {
  if (!value || typeof value !== 'object') return structuredClone(DISABLED_CHILD_ENGINES)
  const record = value as Record<string, unknown>
  const codex = launch(record.codex)
  const claudeCode = launch(record.claudeCode)
  const sdk = launch(record.sdk)
  const protocol = (record.sdk as { protocol?: unknown } | undefined)?.protocol
  if (!codex || !claudeCode || !sdk || (protocol !== 'sdk' && protocol !== 'acp'))
    return structuredClone(DISABLED_CHILD_ENGINES)
  return { codex, claudeCode, sdk: { ...sdk, protocol } }
}

export function childEngineSettingsError(settings: ChildEngineSettings): 'allow' | 'command' | undefined {
  for (const engine of [settings.codex, settings.claudeCode, settings.sdk]) {
    if (!engine.enabled) continue
    if (!engine.command.trim()) return 'command'
    if (!commandAllowed(engine.command, engine.allow)) return 'allow'
  }
  return undefined
}

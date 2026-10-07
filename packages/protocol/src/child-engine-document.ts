/** Persisted child-engine document. Browser-safe: it does not spawn processes. */

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

export const CHILD_ENGINE_ROW_IDS = {
  codex: 'child-agent:codex',
  claudeCode: 'child-agent:claude-code',
  sdk: 'child-agent:sdk',
} as const

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

/** Exact command match. Basenames do not allow a different path. An empty list refuses every command. */
export function commandAllowed(command: string, allow: readonly string[]): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  return allow.some((entry) => entry.trim() === trimmed)
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

/** One engine row. Extra fields, including `env`, are dropped and never persisted. */
export function readEngineDocument(value: unknown): EngineDocument | undefined {
  return launch(value)
}

export function readSdkEngineDocument(
  value: unknown,
): (EngineDocument & { protocol: 'sdk' | 'acp' }) | undefined {
  const parsed = launch(value)
  const protocol = value && typeof value === 'object' ? (value as { protocol?: unknown }).protocol : undefined
  if (!parsed || (protocol !== 'sdk' && protocol !== 'acp')) return undefined
  return { ...parsed, protocol }
}

/** Strict document. `undefined` means the shape is unusable; it is not a disabled default. */
export function readChildEngineSettings(value: unknown): ChildEngineSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const codex = readEngineDocument(record.codex)
  const claudeCode = readEngineDocument(record.claudeCode)
  const sdk = readSdkEngineDocument(record.sdk)
  if (!codex || !claudeCode || !sdk) return undefined
  return { codex, claudeCode, sdk }
}

/** Row config published to the plugin. `env` is not part of the saved document. */
export function childEngineRowConfig(engine: EngineDocument & { protocol?: 'sdk' | 'acp' }) {
  return {
    enabled: engine.enabled,
    command: engine.command,
    args: [...engine.args],
    allow: [...engine.allow],
    ...(engine.protocol === undefined ? {} : { protocol: engine.protocol }),
  }
}

export function childEngineSettingsError(settings: ChildEngineSettings): 'allow' | 'command' | undefined {
  for (const engine of [settings.codex, settings.claudeCode, settings.sdk]) {
    if (!engine.enabled) continue
    if (!engine.command.trim()) return 'command'
    if (!commandAllowed(engine.command, engine.allow)) return 'allow'
  }
  return undefined
}

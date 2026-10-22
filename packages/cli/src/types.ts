import type { Host, Prompter, WorkspaceBinding } from '@agnes/host'
import type { LoopSelection, SlotName } from '@agnes/protocol'
import type { JsonRpcMessage, NodeClient } from '@agnes/sdk'

export type ModelSel = { slot: SlotName; route: string; model: string }

/** Durable daemon admission used by import; same bind/activate rules as session/new. */
export type SessionAdmissionPort = {
  reserve(sessionKey: string, cwd: string): Promise<{ binding: WorkspaceBinding; reservedNew: boolean }>
  activate(sessionKey: string, reservedNew: boolean): void
}
export type Command =
  | 'app'
  | 'app-server'
  | 'run'
  | 'batch'
  | 'runtime'
  | 'tools'
  | 'resume'
  | 'sessions'
  | 'export'
  | 'import'
  | 'home'
  | 'doctor'
  | 'diagnostics'
  | 'approvals'
  | 'schedules'
  | 'triggers'
  | 'settings'
  | 'credentials'
  | 'agents'
  | 'queue'
  | 'api'
  | 'computer-use'
  | 'profile'
  | 'plugin'
  | 'plugins'
  | 'package'
  | 'packages'
  | 'dev'
  | 'install'
  | 'resources'
  | 'skills'
  | 'consent'
  | 'stats'
  | 'config'
  | 'conformance'
  | 'daemon'
  | 'ext'
  | 'mcp'
  | 'serve'
  | 'web'
  | 'start'
  | 'acp'
  | 'completion'

export type ParsedArgs = {
  command?: Command
  positional: string[]
  /** Everything after a forwarded command, untouched: that command owns its own grammar. */
  rest: string[]
  print: boolean
  mode?: 'text' | 'json' | 'stream-json' | 'acp'
  help: boolean
  yes?: boolean
  version: boolean
  profile?: string
  preset?: string
  /** A permission level, or `default` for the deployment default; travels with `preset` on session/new. */
  permission?: 'read-only' | 'workspace-write' | 'full-access' | 'default'
  agent?: string
  loop?: LoopSelection
  cwd?: string
  /** Explicit Computer Use rescue store; bypasses profile/package resolution. */
  dataDir?: string
  candidateHash?: string
  reviewHash?: string
  newSession?: boolean
  continue: boolean
  resume?: string
  connect?: string
  model?: ModelSel
  park: boolean
  ephemeral: boolean
  /** Keep the historical embedded Host/daemon form for an intentional one-shot run. */
  standalone?: boolean
  json: boolean
  repair: boolean
  upgrade: boolean
  format?: 'agnes' | 'sharegpt' | 'claude-code'
  html: boolean
  raw: boolean
  out?: string
  from?: 'claude-code' | 'codex' | 'pi' | 'auto'
  key?: string
  resolved: boolean
  /** `sessions list --archived`: only archived sessions. */
  archived: boolean
  /** `sessions deliverables --save`: the deliverable to download, by number or id. */
  save?: string
  /** `sessions undo --turn`: the turn whose file changes to undo; the latest one when absent. */
  turn?: string
  /** `sessions deliverables --save`: replace an existing target file. */
  force: boolean
  /** `schedules`: list every schedule rather than one session's. */
  all?: boolean
  /** `-p --output-schema`: a JSON Schema file the final reply must satisfy. */
  outputSchema?: string
  /** `sessions list --last`: only the most recently active session. */
  last?: boolean
  /** Private host only: also skip hooks, non-built-in plugins and MCP servers (see parseArgs for what is honoured). */
  safeMode?: boolean
  /** Private host only: do not load personal and project custom slash commands, nor instruction files. */
  ignoreRules?: boolean
  /** Interactive mode: keep the shell screen and write finished turns into its scrollback. */
  noAltScreen?: boolean
  /** `queue`: steer the turn in flight instead of queueing a follow-up. */
  steer?: boolean
  /** `schedules add|edit` task text, title and exactly one of the selector flags. */
  prompt?: string
  title?: string
  every?: string
  cron?: string
  at?: string
  daily?: string
  weekly?: string
  tz?: string
  unattended?: 'notify' | 'refuse'
  /** `triggers`: a JSON file (or `-` for stdin) holding the rule, the configuration or the test payload. */
  file?: string
  /** `settings`: the system prompt replacement, or the search test query. */
  text?: string
  /** `api`: the JSON params object (or `-` for stdin). */
  params?: string
  payload?: string
  /** `approvals suggest`: how far back to look, the smallest count worth suggesting, and how many to show. */
  days?: string
  minCount?: string
  /** `--limit` raw value, range-checked by the command that reads it (`approvals suggest`, `sessions list`). */
  limit?: string
  /** Explicitly permit provider doctor to issue its bounded minimal-inference probe. */
  probe: boolean
  /** Repeated Computer Use doctor check selectors. Owned by that command's grammar. */
  include?: string[]
  /** Repeated Computer Use doctor exclusions. Owned by that command's grammar. */
  skip?: string[]
}

/** The daemon-shaped half-duplex endpoint exposed only by a local ACP boot. */
export type CliRpcEndpoint = {
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors daemon/sdk's structural endpoint seam
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage | void>
  notifications: AsyncIterable<JsonRpcMessage>
  close(): Promise<void>
}

/**
 * What a completed boot hands to a mode. The client is the only handle on the session: whether it
 * runs in this process, over a unix socket or over a websocket is settled here and invisible above.
 */
export type Booted = {
  client: NodeClient
  /** Present when stdio ACP owns the local endpoint directly instead of going through the SDK. */
  endpoint?: CliRpcEndpoint
  /** Present for the local one-shot form; commands that need privileged Host APIs fail closed without it. */
  host?: Host
  /** Present for local import: registers owner and workspace binding in sessions.db. */
  sessionAdmission?: SessionAdmissionPort
  profileName: string
  resolvedProfileHash: string | null
  bootMs: number
  form: 'local' | 'connect'
  close(): Promise<void>
}

/**
 * Everything boot reads about the world, passed in rather than read from globals, so a test can
 * describe a machine it does not have. There is deliberately no platform field: host owns that.
 */
export type BootDeps = {
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
  agnesVersion: string
  signal?: AbortSignal
  prompter?: Prompter
  log: (line: string) => void
}

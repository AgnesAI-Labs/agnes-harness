import type { Host, Prompter, WorkspaceBinding } from '@agnes/host'
import type { SlotName } from '@agnes/protocol'
import type { JsonRpcMessage, NodeClient } from '@agnes/sdk'

export type ModelSel = { slot: SlotName; route: string; model: string }

/** Durable daemon admission used by import; same bind/activate rules as session/new. */
export type SessionAdmissionPort = {
  reserve(sessionKey: string, cwd: string): Promise<{ binding: WorkspaceBinding; reservedNew: boolean }>
  activate(sessionKey: string, reservedNew: boolean): void
}
export type Command =
  | 'resume'
  | 'sessions'
  | 'export'
  | 'import'
  | 'doctor'
  | 'computer-use'
  | 'profile'
  | 'package'
  | 'packages'
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
  | 'acp'

export type ParsedArgs = {
  command?: Command
  positional: string[]
  /** Everything after a forwarded command, untouched: that command owns its own grammar. */
  rest: string[]
  print: boolean
  mode?: 'text' | 'json' | 'acp'
  help: boolean
  version: boolean
  profile?: string
  preset?: string
  cwd?: string
  /** Explicit Computer Use rescue store; bypasses profile/package resolution. */
  dataDir?: string
  continue: boolean
  resume?: string
  connect?: string
  model?: ModelSel
  park: boolean
  meta: boolean
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

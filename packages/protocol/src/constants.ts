export const EVENT_TYPES = [
  // Lifecycle
  'session/start',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  // Model-visible
  'user/message',
  'assistant/message',
  'tool/result',
  // Raw record
  'assistant/output',
  'tool/call',
  'request/header',
  'request/sent',
  // Registers (6)
  'op.state',
  'plan.items',
  'budget.state',
  'artifact/job',
  'inbox',
  'harness/entry',
  // Adjudication and ledger
  'effect/intent',
  'effect/settled',
  'verifier/signal',
  'repair/decision',
  'format/deviation',
  'cost/ledger',
  'approval/asked',
  'approval/decided',
  'approval/guardian-decided',
  'feedback/rating',
  'feedback/implicit',
  'participant',
  'harness/refine',
  'subagent/cost',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EXT_EVENT_PATTERN =
  /^x\/(?:(?:core|agnes)\/[a-z0-9-]+|host\/session-title|[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+)$/
export const EXT_EVENT_PATTERN_SOURCE = EXT_EVENT_PATTERN.source // the same string written into the schema

export function isEventType(s: string): boolean {
  return (EVENT_TYPES as readonly string[]).includes(s) || EXT_EVENT_PATTERN.test(s)
}

/**
 * The harness's own directory name: `<os home>/.agh` by default, and `<workspace>/.agh` in every
 * workspace. It is not `.agnes` because another product already owns that name on the same machines.
 */
export const AGH_DIR = '.agh'
/**
 * Workspace-relative directories every file tool and sandbox hard-denies. `.agnes/secrets` is where
 * this directory lived before the rename; it stays denied so a workspace still holding one is not exposed.
 */
export const WORKSPACE_SECRET_DIRS = ['.agh/secrets', '.agnes/secrets'] as const

export const META_KEY = 'ai.agnes.harness' as const
export const AGNES_NS = '_agnes/v1' as const
export const SESSION_FORMAT = 'agnes-session/v1' as const
/** UTF-8 JSON message bytes, excluding the JSONL delimiter (LF). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
/**
 * Largest canonical base64 payload whose closed `runtime.stale` JSON envelope fits in one frame.
 * Base64 length must be a multiple of four; the current envelope has 425 fixed ASCII bytes.
 */
export const MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH = 16_776_788
/** Raw-byte ceiling for one JSON-RPC artifact range response. Larger artifacts are read in ranges. */
export const ARTIFACT_READ_RPC_MAX_BYTES = 1024 * 1024
/** Default and hard request ceilings for bounded UI projection reads (IP10). */
export const UI_OPENING_DEFAULT_MAX_NODES = 200
export const UI_OPENING_MAX_NODES = 500
export const UI_HISTORY_DEFAULT_LIMIT = 100
export const UI_HISTORY_MAX_LIMIT = 200
export const UI_PROJECTION_DEFAULT_MAX_BYTES = 256 * 1024
export const UI_PROJECTION_MIN_MAX_BYTES = 16 * 1024
export const UI_PROJECTION_MAX_BYTES = 1024 * 1024
/** Safe detail code requesting a fresh bounded opening snapshot, not an unbounded replacement. */
export const UI_PROJECTION_RESYNC_REQUIRED = 'UI_PROJECTION_RESYNC_REQUIRED' as const
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

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
  // Registers written as rows (5); the program counter is written as a register cell only
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
/** UTF-8 JSON bytes; room for 100 MiB attachments encoded as Base64 plus the envelope. */
export const MAX_FRAME_BYTES = 144 * 1024 * 1024
/**
 * Runtime targets retain their original 16 MiB frame budget independently of attachment frames.
 * Base64 length is a multiple of four; the closed envelope has 425 fixed ASCII bytes.
 */
export const MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH = 16_776_788
/** Raw-byte ceiling for one JSON-RPC artifact range response. Larger artifacts are read in ranges. */
export const ARTIFACT_READ_RPC_MAX_BYTES = 1024 * 1024
/** Raw bytes in one `_agnes/v1/attachment.upload` chunk; Base64 makes it at most 1,398,104 characters. */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 1024 * 1024
/**
 * The thumbnail a client makes for an uploaded image and uploads as a second object: the longest edge
 * at most `maxEdge` pixels, JPEG at `jpegQuality`, and at most `maxBytes`.
 */
export const USER_ATTACHMENT_THUMBNAIL = Object.freeze({ maxEdge: 320, jpegQuality: 0.8, maxBytes: 262_144 })
/**
 * The codes (`data.code` of a SEMANTIC_REJECTED error) for a refused attachment: an upload step, or a
 * prompt, steer or follow-up whose attachment was refused before anything was queued.
 */
export const ATTACHMENT_REFUSAL_CODES = Object.freeze([
  'UPLOAD_INVALID',
  'UPLOAD_SIZE_LIMIT',
  'UPLOAD_OFFSET',
  'UPLOAD_HASH_MISMATCH',
  'UPLOAD_INCOMPLETE',
  'UPLOAD_CANCELLED',
  'UPLOAD_BUSY',
  'UPLOAD_EXPIRED',
  'UPLOAD_QUOTA',
  'UPLOAD_UNAVAILABLE',
  'UPLOAD_NOT_IMAGE',
  'ATTACHMENT_NOT_AUTHORIZED',
  'ATTACHMENT_MISSING',
  'ATTACHMENT_DATA',
  'ATTACHMENT_BYTES',
  'ATTACHMENT_CORRUPT',
  'ATTACHMENT_HASH_MISMATCH',
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_TIMEOUT',
  'ATTACHMENT_UNAVAILABLE',
] as const)
export type AttachmentRefusalCode = (typeof ATTACHMENT_REFUSAL_CODES)[number]
/** Default and hard request ceilings for bounded UI projection reads (IP10). */
export const UI_OPENING_DEFAULT_MAX_NODES = 200
export const UI_OPENING_MAX_NODES = 500
export const UI_HISTORY_DEFAULT_LIMIT = 100
export const UI_HISTORY_MAX_LIMIT = 200
export const UI_PROJECTION_DEFAULT_MAX_BYTES = 256 * 1024
export const UI_PROJECTION_MIN_MAX_BYTES = 16 * 1024
export const UI_PROJECTION_MAX_BYTES = MAX_FRAME_BYTES - 4096
/** Safe detail code requesting a fresh bounded opening snapshot, not an unbounded replacement. */
export const UI_PROJECTION_RESYNC_REQUIRED = 'UI_PROJECTION_RESYNC_REQUIRED' as const
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

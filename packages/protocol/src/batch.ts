import type { BatchSpec } from '../gen/ts/agnes-v1.js'

/**
 * A session tool's request to the daemon batch engine. The daemon takes the session identity from
 * the worker transport, never from this value; `sessionKey` only lets the worker refuse a mismatch.
 */
export type BatchRequest =
  | Readonly<{ op: 'start'; sessionKey: string; toolUseId: string; cwd: string; spec: BatchSpec }>
  | Readonly<{ op: 'status'; sessionKey: string; batchId: string; export?: boolean }>
  | Readonly<{ op: 'cancel'; sessionKey: string; batchId: string }>

/** Item sessions of a batch end in `:batch:<batch id>:<ordinal>`. */
export const BATCH_ITEM_SESSION_PATTERN = /:batch:b[0-9a-f]{12}:\d+$/

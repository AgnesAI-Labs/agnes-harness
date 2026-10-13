import type { BatchRequest, BatchStatus } from '@agnes/protocol'

/** Request-only daemon bridge for the bundled batch tools; the daemon stamps the session itself. */
export type BatchBridge = (input: BatchRequest, signal: AbortSignal) => Promise<BatchStatus>

import type { McpStatus } from '@agnes/protocol'

export type McpStatusFrame = Readonly<{ kind: 'resourceStatus'; serverId: string; status: McpStatus }>

/**
 * Queues `resourceStatus` frames a row reports before `hello` has gone out, and releases them once it
 * has. An MCP row can start connecting - and so report its first `connecting`/`ready`/`unavailable`
 * status - while `runWorker` is still assembling Host, strictly before `hello` is sent: the daemon's
 * link only learns this worker's key from `hello` itself, so a frame written ahead of it would arrive
 * unattributed and be silently dropped, leaving a freshly booted server's status stuck stale until
 * some later, unrelated event happened to report it again. Frames reported after `open()` runs go
 * straight through; nothing is buffered once this worker's identity is established.
 */
export function createMcpStatusFrameBuffer(send: (frame: McpStatusFrame) => void): {
  report(serverId: string, status: McpStatus): void
  /** Sends every buffered frame, in the order reported, then stops buffering. Idempotent. */
  open(): void
} {
  let opened = false
  const pending: McpStatusFrame[] = []
  return {
    report(serverId, status) {
      const frame: McpStatusFrame = { kind: 'resourceStatus', serverId, status }
      if (opened) send(frame)
      else pending.push(frame)
    },
    open() {
      if (opened) return
      opened = true
      for (const frame of pending.splice(0)) send(frame)
    },
  }
}

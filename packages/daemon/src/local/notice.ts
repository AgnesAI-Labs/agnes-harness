import type { DaemonNotice } from '@agnes/protocol'
import { notify } from '../rpc.js'
import { type DaemonNoticeKind, noticeParams } from './attached.js'
import type { ConnectionState, LocalEndpoint } from './endpoint.js'

// DaemonNoticeKind is the protocol schema's closed set (DaemonNotice['kind']); re-exported under this
// name because NoticeSink is the consumer surface callers reach for, not attached.ts.
export type NoticeKind = DaemonNoticeKind

export type PackagesChangedReason = 'inventory' | 'activation' | 'trust' | 'resources' | 'rebuilt'

export type PackagesChangedDetail = {
  profile: string
  revision: string
  reason: PackagesChangedReason
  packageId?: string
}

export type TreeChangedDetail = {
  profile: string
  targetDigest: string
  identity: {
    treeHash: string
    resourceRevision: string
    compositeRevision: string
  }
  hash: string
}

/**
 * Fans a server-initiated event out to every connection that has standing to hear it, over
 * whatever endpoints happen to exist at emit time (`endpoints()` is read fresh each call, not
 * captured once, so a connection that attaches or disconnects between two emits is picked up
 * without this class needing to be told). `shutting_down` is the one kind with no session of its
 * own to route by, so it goes to everyone; every other kind is session-scoped and only reaches a
 * connection that is actually attached to that session - a connection that never attached has no
 * use for a session's lifecycle notices and no way to correlate them.
 *
 * The notification is built once, through `noticeParams()` (the sole construction point for a
 * DaemonNotice payload; see attached.ts), and the same object is both pushed to every routed
 * connection and handed to the audit sink - one `at` timestamp per emitted notice, not one per
 * recipient. `packages_changed` is profile-scoped rather than session-scoped: it reaches every
 * initialized, credential-verified connection bound by the server to the matching profile,
 * including pages which have not attached to a session.
 */
export class NoticeSink {
  constructor(
    private readonly o: {
      endpoints: () => Array<{ ep: LocalEndpoint; conn: ConnectionState }>
      audit?: (rec: unknown) => void
      clock: () => number
    },
  ) {}

  emit(kind: 'packages_changed', o: { detail: PackagesChangedDetail }): void
  emit(kind: 'tree_changed', o: { detail: TreeChangedDetail }): void
  emit(
    kind: Exclude<NoticeKind, 'packages_changed' | 'tree_changed'>,
    o: { sessionId?: string; detail: unknown },
  ): void
  emit(kind: NoticeKind, o: { sessionId?: string; detail: unknown }): void {
    // exactOptionalPropertyTypes forbids passing `sessionId: undefined` where the target type says
    // `sessionId?: string` (not `string | undefined`), so the key is included only when present.
    const n = notify(
      '_agnes/v1/daemon.notice',
      noticeParams(kind, {
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
        detail: o.detail,
        atMs: this.o.clock(),
      }),
    )
    const params = n.params as DaemonNotice
    const noticeProfile =
      (kind === 'packages_changed' || kind === 'tree_changed') &&
      typeof o.detail === 'object' &&
      o.detail !== null &&
      typeof (o.detail as { profile?: unknown }).profile === 'string'
        ? (o.detail as { profile: string }).profile
        : undefined
    for (const { ep, conn } of this.o.endpoints())
      if (
        kind === 'shutting_down' ||
        (kind === 'packages_changed' || kind === 'tree_changed'
          ? noticeProfile !== undefined &&
            conn.profile === noticeProfile &&
            conn.initialized &&
            conn.authKind !== undefined &&
            conn.clientModuleNotices
          : o.sessionId !== undefined && conn.attached.has(o.sessionId))
      )
        ep.push(n)
    // Nested rather than spread: `params` is a DaemonNotice and carries its own `kind` (e.g.
    // 'resumed'), which would silently clobber the audit record's own 'daemon.notice' discriminator
    // if spread in - the two `kind` fields name different things (audit-record type vs. notice type).
    this.o.audit?.({ kind: 'daemon.notice', notice: params })
  }
}

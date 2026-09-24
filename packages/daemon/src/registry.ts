import type { EventEnvelope, SessionPreviewParams } from '@agnes/protocol'
import type { Disposer } from './local/tail.js'
import type { WorkspaceBindingEnvelope } from './storage/workspaces.js'

/**
 * The method shape shared by `local/sessions.ts`'s `SessionRegistry` (in-process sessions) and
 * `supervisor/registry.ts`'s `WorkerRegistry` (worker-process-backed sessions). Both classes formally
 * `implements Registry<...>` against this - the generic parameter is each class's own entry type
 * (`SessionEntry`, `RemoteEntry`), never a shared concrete shape, since a `SessionEntry` carries an
 * in-process `HostSession` and a `RemoteEntry` carries a `RemoteSession` proxy and the two are not
 * otherwise related.
 *
 * `open`'s option type is intentionally the narrower of the two classes' real parameter types:
 * `WorkerRegistry.open` accepts a few more optional fields (`parent`, `forkAt`, `resume`) that
 * `SessionRegistry.open` does not. Since every extra field is optional, `WorkerRegistry`'s wider
 * parameter type still structurally satisfies this narrower one - a caller going through `Registry<T>`
 * can only ever supply the fields listed here, and `WorkerRegistry.open` accepts that shape (the extra
 * fields it declares just go unset). Widening this interface's `open` to include those fields would be
 * wrong in the other direction: `SessionRegistry.open` does not understand them, so `Registry<T>` stays
 * at the common subset both implementations actually honor.
 *
 * This is the type `local/methods/acp.ts`'s `LocalContext.registry` is declared against, so a future
 * `startSupervisor` path can hand it a `WorkerRegistry` instead of a `SessionRegistry` without
 * `registerAcp`/`registerAgnes` changing at all.
 */
/** One live piece of streamed model text for a session; never a ledger row. */
export type PreviewUpdate = Omit<SessionPreviewParams, 'sessionId'>
/** The text an inference still in flight has streamed so far. */
export type PreviewSnapshotEntry = { lane: string; effectId: string; text: string; thinking: string }

export interface Registry<Entry> {
  open(o: {
    key?: string
    cwd: string
    binding?: WorkspaceBindingEnvelope
    preset?: string
    credential?: unknown
  }): Promise<Entry>
  fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<Entry>
  get(key: string): Entry | undefined
  require(key: string): Entry
  subscribe(key: string, fn: (e: EventEnvelope) => void): Disposer
  /** `gap` is called when previews for the session were lost before reaching `fn`; resync then. */
  subscribePreview(key: string, fn: (p: PreviewUpdate) => void, gap?: () => void): Disposer
  previewSnapshot(key: string): Promise<PreviewSnapshotEntry[]>
  keys(): string[]
  close(key: string): Promise<void>
  closeAll(): Promise<void>
}

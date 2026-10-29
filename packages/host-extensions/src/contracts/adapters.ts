import type { ApprovalAnswer, ApprovalRequest, Verdict } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { ExecAdapter, ExecGateState } from '@agnes/host-infrastructure/adapters/exec'
import type { HostFs } from '@agnes/host-infrastructure/adapters/fs'
import type { PlatformBackend, SandboxBackendReport } from '@agnes/host-infrastructure/adapters/platform'
import type { RemoteTransport } from '@agnes/host-infrastructure/adapters/remote-transport'
import type { TableStore } from '@agnes/host-infrastructure/adapters/storage-sqlite'

// The deadline is carried by the signal rather than by a field grafted onto the request, so one
// prompter serves both a timeout and an explicit cancellation.
export type Prompter = {
  ask(req: ApprovalRequest, opts: { signal: AbortSignal }): Promise<Verdict | ApprovalAnswer>
}

// Two file handles, fenced at two different roots, because they answer two different questions.
// `fs` is the user's workspace. `dataFs` is this installation's own store under dataDir, where the
// artifacts seam writes content-addressed bytes and the checkpoint seam keeps its shadow git - and
// dataDir defaults to ~/.agh/data, which is outside the workspace and so is refused by `fs`. Handing
// seams only `fs` did not make them safer; it made every write to their own store an E_FS_DENIED.
export type SeamAdapters = {
  shell?: Readonly<{ description: string }>
  fs: HostFs
  dataFs: HostFs
  exec: ExecAdapter['run']
  platform: PlatformBackend
  storage: TableStore & {
    namespace(name: string): PersistenceMetadataNamespace
  }
  prompter?: Prompter
}

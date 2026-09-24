import type {
  ArtifactRef,
  ExecResult,
  FetchInit,
  FsEntry,
  FsStat,
  Logger,
  PublicFetch,
  ToolContext,
  ToolDef,
  ToolResult,
} from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { ArtifactJob, PlanItem } from '../reduce/shapes.js'
import type { PresetView } from '../step/preset.js'
import { CoreError, type Seq } from '../types.js'
import type { CheckpointWorkspaceContext, WorkspaceHookSandbox } from '../workspace/runtime.js'
import { assertNotDenied } from './fs-guard.js'
import type { SeamRuntime } from './wrap.js'

export type ChildStatus = { state: 'running' | 'done' | 'error'; lastSeq: Seq; text?: string }
export type ChildHandle = {
  key: string
  worktree?: string
  run(input: string): Promise<{ text: string; lastSeq: Seq }>
  status(): Promise<ChildStatus>
  close(): Promise<void>
  cancel?(): Promise<void>
}
export type ChildrenFactory = {
  create(opts: {
    parent: string
    forkAt?: Seq
    preset?: string
    cwd: string
    model?: string
    budget?: number
    isolation?: 'worktree' | 'shared'
    input?: string
    parentEffectId?: string
    start?: boolean
  }): Promise<ChildHandle>
  /** Optional richer entry used by the built-in factory without changing third-party create args. */
  createWithKind?(
    kind: 'fork' | 'spawn',
    opts: Parameters<ChildrenFactory['create']>[0],
  ): Promise<ChildHandle>
  get?(childKey: string): ChildHandle | undefined
  inspect?(childKey: string): Promise<ChildStatus | null>
  resume?(childKey: string): Promise<ChildHandle>
  cancel?(childKey: string): Promise<void>
}

/**
 * The four file operations, supplied by the host. Core cannot import a filesystem - it has no
 * platform of its own - so both the bytes and the path policy belong to whoever assembled the
 * session. An implementation must refuse a path its policy denies, and a refusal must be
 * distinguishable from a missing file: throw an error whose `code` is `E_FS_DENIED`, or whose
 * message carries it. Core checks that before a session opens and refuses to open one otherwise.
 */
export type FsOps = {
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(path: string, data: Uint8Array | string): Promise<void>
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
}

export type ToolContextDeps = {
  sessionKey: string
  lane: string
  turn: number
  step: number
  depth: number
  generationDepth: number
  actor: Actor
  cwd: string
  runtime: SeamRuntime
  preset: PresetView
  children: ChildrenFactory
  fsOps: FsOps
  /** Capabilities from the one tool-level WorkspaceInvocationPort lease. */
  workspace?: Readonly<{
    sandbox: WorkspaceHookSandbox
    confine(argv: readonly string[]): Promise<readonly string[]>
    checkpoint: CheckpointWorkspaceContext
  }>
  netFetch(url: string, init?: FetchInit): Promise<Response>
  publicFetch?: PublicFetch
  log: Logger
  invoke(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; depth: number; parentEffectId?: string },
  ): Promise<ToolResult>
  listTools(): ToolDef[]
  appendPlan(items: PlanItem[]): Promise<Seq>
  requestCompaction(instructions?: string): void
  progress(note: string): void
  artifactJobEvent(job: ArtifactJob): Promise<void>
  lease: { remainingMs(): number }
}

/**
 * Every side effect a tool can reach, and nothing else. A tool is handed this object and no
 * ambient capability: the sandbox, the approval-bearing seams and the ledger are all on the other
 * side of it, so what a tool did is recoverable from the ledger rather than from the process.
 *
 * The path policy is not applied here. It used to be, on the raw string the caller wrote, while the
 * file system underneath applied the same rule again after resolving symlinks and folding case -
 * two statements of one rule, and the weaker one was the one the kernel showed a reader. The rule
 * now lives only in the FsOps, which is the layer that can resolve a name into the file it names.
 * What core owes instead is that no FsOps reaches a session without enforcing one, and that is
 * discharged by assertFsEnforces before the session opens.
 */
export function buildToolContext(
  d: ToolContextDeps,
  call: { toolUseId: string; name: string; signal: AbortSignal; timeoutMs: number },
): ToolContext {
  const stepId = `${d.turn}/${d.step}`
  const publicFetch = d.publicFetch
  return {
    session: {
      key: d.sessionKey,
      lane: d.lane,
      workspaceRoot: d.cwd,
      turn: d.turn,
      step: d.step,
      toolUseId: call.toolUseId,
      depth: d.depth,
      generationDepth: d.generationDepth,
    },
    projections: unavailableProjections,
    actor: d.actor,
    cwd: d.cwd,
    exec: (cmd, opts): Promise<ExecResult> => {
      if (!d.workspace)
        return Promise.reject(
          new CoreError('E_WORKSPACE_CLOSED', 'sandbox is unavailable outside a workspace invocation'),
        )
      return d.workspace.sandbox.exec(cmd, {
        cwd: opts?.cwd ?? d.cwd,
        ...(opts?.env ? { env: opts.env } : {}),
        ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts?.timeoutMs ?? call.timeoutMs,
        signal: call.signal,
      })
    },
    fs: {
      read: (path, opts) => d.fsOps.read(path, opts),
      // A write is snapshotted before it happens, so a rewind has something to go back to. An
      // unavailable checkpoint seam therefore stops the write rather than losing the old bytes.
      // The file system is asked about the path first, so a snapshot is not taken of a file the
      // write is about to be refused for - asked, not decided here, and a missing file is not a
      // refusal because the path being written may not exist yet.
      write: async (path, data) => {
        await assertNotDenied(d.fsOps, path)
        const snap = await d.runtime.checkpointSnapshot([path], stepId, d.workspace?.checkpoint)
        if (!snap.ok)
          throw new CoreError('E_SEAM_MISSING', `checkpoint unavailable: ${snap.reason}`, { path })
        return d.fsOps.write(path, data)
      },
      list: (path) => d.fsOps.list(path),
      stat: (path) => d.fsOps.stat(path),
    },
    net: {
      fetch: (url, init) => d.netFetch(url, init),
      ...(publicFetch
        ? {
            fetchPublic: (url: string, options?: { responseType: 'zip' }) =>
              publicFetch(url, {
                signal: call.signal,
                timeoutMs: Math.min(call.timeoutMs, d.lease.remainingMs()),
                ...options,
              }),
          }
        : {}),
    },
    sandbox: {
      confine: async (argv) => {
        if (!d.workspace)
          throw new CoreError('E_WORKSPACE_CLOSED', 'sandbox is unavailable outside a workspace invocation')
        return [...(await d.workspace.confine(argv))]
      },
      // Through SeamRuntime.enforcement(), not the raw seam: it is the same straight-through read
      // (SeamRuntime does not cache it), but it also gets core's usual fail-closed bound - a broken
      // sandbox backend answers { level: 'none', scope: [] } instead of throwing into tool code, and
      // the failure is recorded via SeamRuntime's diagnostic rather than lost.
      enforcement: () => {
        const e = d.workspace
          ? d.runtime.enforcement(d.workspace.sandbox)
          : { level: 'none' as const, scope: [] }
        return Object.freeze({ level: e.level, scope: Object.freeze([...e.scope]) })
      },
    },
    // Facts read at call time, probe passed through; no manifest gate (spec 2026-09-15 P3).
    platform: d.runtime.platformView(),
    // Action and Target are protocol's, and until protocol publishes them they are JsonValue here.
    // The conversion is a cast at this one boundary rather than a shape core invents.
    authorize: (action, target) =>
      d.runtime.authorize(d.actor, String(action), target as never) as unknown as Promise<never>,
    tools: {
      invoke: (name, args, opts) => {
        if (d.depth + 1 > d.preset.depthLimit)
          throw new CoreError('E_DEPTH_EXCEEDED', `depth ${d.depth + 1} exceeds ${d.preset.depthLimit}`)
        const signal = opts?.signal ? AbortSignal.any([call.signal, opts.signal]) : call.signal
        return d.invoke(name, args, { signal, depth: d.depth + 1 })
      },
      list: () => d.listTools(),
    },
    artifacts: {
      put: (bytes, meta) => d.runtime.artifactPut(bytes, meta) as Promise<ArtifactRef>,
      get: (ref) => d.runtime.artifactGet(ref),
      submitJob: async (spec) => {
        // A tool cannot name another session. Explicitly write trusted identity after the spread,
        // including for untyped JavaScript callers, and install the local one-shot default here.
        const jobId = await d.runtime.submitJob({
          ...spec,
          sessionKey: d.sessionKey,
          schedule: spec.schedule ?? { kind: 'once' },
        })
        await d.artifactJobEvent({ jobId, status: 'queued' })
        return jobId
      },
      poll: (id) => d.runtime.artifactPoll(id) as unknown as Promise<never>,
      cancel: (id) => d.runtime.artifactCancel(id),
    },
    subagent: {
      fork: async (question, opts) => {
        const childOpts = {
          parent: d.sessionKey,
          cwd: d.cwd,
          input: question,
          parentEffectId: call.toolUseId,
          ...(opts?.model !== undefined ? { model: opts.model } : {}),
        }
        const child = d.children.createWithKind
          ? await d.children.createWithKind('fork', childOpts)
          : await d.children.create(childOpts)
        try {
          return (await child.run(question)).text
        } finally {
          await child.close()
        }
      },
      spawn: async (task, opts) => {
        const childOpts = {
          parent: d.sessionKey,
          cwd: opts?.cwd ?? d.cwd,
          input: task,
          parentEffectId: call.toolUseId,
          ...(opts?.model !== undefined ? { model: opts.model } : {}),
          ...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
          ...(opts?.isolation !== undefined ? { isolation: opts.isolation } : {}),
          ...(opts?.start === false ? { start: false as const } : {}),
        }
        const child = d.children.createWithKind
          ? await d.children.createWithKind('spawn', childOpts)
          : await d.children.create(childOpts)
        if (opts?.start !== false) void child.run(task).catch(() => undefined)
        return { childKey: child.key, ...(child.worktree ? { worktree: child.worktree } : {}) }
      },
      resume: async (childKey) => {
        const child = d.children.resume ? await d.children.resume(childKey) : d.children.get?.(childKey)
        if (!child) throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
        return { childKey: child.key, ...(child.worktree ? { worktree: child.worktree } : {}) }
      },
      collect: async (childKey, opts) => {
        const snapshot = async () => {
          const child = d.children.get?.(childKey)
          if (child) {
            const status = await child.status()
            return {
              childKey: child.key,
              status: (status.state === 'done'
                ? 'completed'
                : status.state === 'error'
                  ? 'failed'
                  : 'running') as 'running' | 'completed' | 'failed' | 'cancelled',
              ...(status.text !== undefined ? { text: status.text } : {}),
            }
          }
          const snap = await d.children.inspect?.(childKey)
          if (!snap) throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
          return {
            childKey,
            status: (snap.state === 'done' ? 'completed' : snap.state === 'error' ? 'failed' : 'running') as
              | 'running'
              | 'completed'
              | 'failed'
              | 'cancelled',
            ...(snap.text !== undefined ? { text: snap.text } : {}),
          }
        }
        if (opts?.wait !== true) return snapshot()
        const deadline = Date.now() + Math.max(1, d.lease.remainingMs())
        while (Date.now() < deadline) {
          const current = await snapshot()
          if (current.status !== 'running') return current
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return { ...(await snapshot()), waitTimedOut: true }
      },
      cancel: async (childKey) => {
        if (d.children.cancel) await d.children.cancel(childKey)
        else {
          const handle = d.children.get?.(childKey)
          if (handle?.cancel) await handle.cancel()
          else if (handle) await handle.close()
        }
        const snap = await d.children.inspect?.(childKey)
        if (!snap) throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
        return {
          childKey,
          status: snap.state === 'done' ? 'completed' : snap.state === 'error' ? 'failed' : 'cancelled',
          ...(snap.text !== undefined ? { text: snap.text } : {}),
        }
      },
    },
    plan: { set: (items) => d.appendPlan(items as unknown as PlanItem[]) },
    requestCompaction: (instructions) => d.requestCompaction(instructions),
    progress: (note) => d.progress(note),
    signal: call.signal,
    timeoutMs: call.timeoutMs,
    lease: {
      expiresAt: new Date(Date.now() + d.lease.remainingMs()).toISOString(),
      scope: {},
      budget: { remaining: 1 },
    },
    log: d.log,
  }
}
